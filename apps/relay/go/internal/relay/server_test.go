package relay

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

const testRoute = "route_0123456789abcdef"

type fixture struct {
	t   *testing.T
	ctx context.Context
	s   *Server
	h   *httptest.Server
}

func start(t *testing.T, o Options) *fixture {
	t.Helper()
	s := New(o)
	h := httptest.NewServer(s)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(func() {
		defer cancel()
		h.Close()
		if err := s.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	return &fixture{t, ctx, s, h}
}
func (f *fixture) socket() *websocket.Conn {
	f.t.Helper()
	c, _, err := websocket.Dial(f.ctx, "ws"+strings.TrimPrefix(f.h.URL, "http")+"/ws", &websocket.DialOptions{Subprotocols: []string{protocol}})
	if err != nil {
		f.t.Fatal(err)
	}
	f.t.Cleanup(func() { c.CloseNow() })
	return c
}
func (f *fixture) write(c *websocket.Conn, m fields) {
	f.t.Helper()
	if err := c.Write(f.ctx, websocket.MessageText, encode(m)); err != nil {
		f.t.Fatal(err)
	}
}
func (f *fixture) read(c *websocket.Conn) []byte {
	f.t.Helper()
	k, b, err := c.Read(f.ctx)
	if err != nil || k != websocket.MessageText {
		f.t.Fatalf("read: type=%v error=%v", k, err)
	}
	return b
}
func (f *fixture) expect(c *websocket.Conn, k, v string) rawMap {
	f.t.Helper()
	m, ok := outer(f.read(c))
	if !ok || m.str(k) != v {
		f.t.Fatalf("expected %s=%s, received %s", k, v, m.str(k))
	}
	return m
}
func (f *fixture) closed(c *websocket.Conn, want websocket.StatusCode) {
	f.t.Helper()
	_, _, err := c.Read(f.ctx)
	if websocket.CloseStatus(err) != want {
		f.t.Fatalf("wanted close %d, got %v", want, err)
	}
}
func reg(secret string) fields {
	hash := sha256.Sum256([]byte(secret))
	return fields{"t": "host.register", "routeId": testRoute, "hostId": "host", "hostSecretHash": hex.EncodeToString(hash[:])}
}
func (f *fixture) host() *websocket.Conn {
	f.t.Helper()
	c := f.socket()
	f.write(c, reg("test-key"))
	f.expect(c, "t", "host.registered")
	return c
}
func join(id string) fields { return fields{"t": "client.join", "routeId": testRoute, "deviceId": id} }
func (f *fixture) client(h *websocket.Conn, id string) *websocket.Conn {
	f.t.Helper()
	c := f.socket()
	f.write(c, join(id))
	f.expect(c, "t", "client.joined")
	f.expect(h, "t", "peer.joined")
	return c
}
func (f *fixture) post(path, key, body string, want int) rawMap {
	f.t.Helper()
	q, err := http.NewRequestWithContext(f.ctx, "POST", f.h.URL+path, strings.NewReader(body))
	if err != nil {
		f.t.Fatal(err)
	}
	q.Header.Set("X-Route-Id", testRoute)
	q.Header.Set("X-Host-Secret", key)
	r, err := f.h.Client().Do(q)
	if err != nil {
		f.t.Fatal(err)
	}
	defer r.Body.Close()
	if r.StatusCode != want {
		f.t.Fatalf("HTTP status %d, want %d", r.StatusCode, want)
	}
	var m rawMap
	if err := json.NewDecoder(r.Body).Decode(&m); err != nil {
		f.t.Fatal(err)
	}
	return m
}

func TestTakeoverForwardAndRevoke(t *testing.T) {
	f := start(t, Options{})
	h := f.host()
	mobile := f.client(h, "mobile")
	other := f.client(h, "other")
	newHost := f.socket()
	f.write(newHost, reg("wrong"))
	f.expect(newHost, "code", "UNAUTHORIZED")
	f.write(newHost, reg("test-key"))
	f.expect(newHost, "t", "host.registered")
	f.closed(h, 4001)
	for _, c := range []*websocket.Conn{mobile, other} {
		f.expect(c, "t", "peer.left")
		f.expect(c, "role", "host")
		f.expect(newHost, "t", "peer.joined")
	}
	replaced := f.socket()
	f.write(replaced, join("mobile"))
	f.expect(replaced, "t", "client.joined")
	f.closed(mobile, 4001)
	f.expect(newHost, "t", "peer.left")
	f.expect(newHost, "t", "peer.joined")
	for _, typ := range []string{"pair", "cipher"} {
		m := fields{"t": typ, "routeId": testRoute, "deviceId": "other"}
		if typ == "cipher" {
			m["frameId"] = "f"
			m["envelope"] = json.RawMessage(`{"seq":9007199254740993,"ct":"abc"}`)
		} else {
			m["payload"] = fields{"t": "pair.hello"}
		}
		f.write(replaced, m)
		f.expect(replaced, "code", "UNAUTHORIZED")
		m["deviceId"] = "mobile"
		raw, err := json.MarshalIndent(m, "", " ")
		if err != nil {
			t.Fatal(err)
		}
		for _, ends := range [][2]*websocket.Conn{{replaced, newHost}, {newHost, replaced}} {
			if err := ends[0].Write(f.ctx, websocket.MessageText, raw); err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(f.read(ends[1]), raw) {
				t.Fatal("wire text changed")
			}
		}
	}
	f.write(newHost, fields{"t": "host.revoke", "deviceId": "mobile", "routeId": testRoute})
	f.expect(replaced, "code", "REVOKED")
	f.closed(replaced, 4003)
	f.expect(newHost, "t", "peer.left")
	f.write(other, fields{"t": "pair", "routeId": testRoute, "deviceId": "other", "payload": "hello"})
	f.expect(newHost, "payload", "hello")
	newHost.CloseNow()
	f.expect(other, "role", "host")
	c := f.socket()
	f.write(c, join("x"))
	f.expect(c, "code", "ROUTE_NOT_FOUND")
	f.write(c, reg("wrong"))
	f.expect(c, "code", "UNAUTHORIZED")
}

func TestTicketsAndGenericWake(t *testing.T) {
	wakes := make(chan Wake, 10)
	f := start(t, Options{RequireTickets: true, Push: func(ctx context.Context, w Wake) error { wakes <- w; return nil }})
	host := f.host()
	c := f.socket()
	f.write(c, join("d"))
	f.expect(c, "code", "UNAUTHORIZED")
	f.post("/v1/tickets", "wrong", "", 401)
	before := time.Now().UnixMilli()
	ticket := f.post("/v1/tickets", "test-key", "{}", 200)
	var exp int64
	if json.Unmarshal(ticket["expiresAt"], &exp) != nil || exp < before+120000 || exp > time.Now().UnixMilli()+120000 {
		t.Fatal("invalid ticket expiration")
	}
	j := join("d")
	j["joinToken"] = ticket.str("joinToken")
	f.write(c, j)
	f.expect(c, "t", "client.joined")
	f.expect(host, "t", "peer.joined")
	retry := f.socket()
	f.write(retry, j)
	f.expect(retry, "code", "UNAUTHORIZED")
	j["joinToken"] = f.post("/v1/tickets", "test-key", "", 200).str("joinToken")
	key := sha256.Sum256([]byte(j["joinToken"].(string)))
	f.s.mu.Lock()
	f.s.routes[testRoute].tickets[key] = time.Now()
	f.s.mu.Unlock()
	f.write(retry, j)
	f.expect(retry, "code", "UNAUTHORIZED")
	path := "/v1/push/wake"
	payload := `{"deviceId":"d","wakeId":"w"}`
	f.post(path, "wrong", payload, 401)
	for _, body := range []string{`{"deviceId":"d","wakeId":"w","body":"x"}`, `{"deviceId":"d","wakeId":"w","wakeId":"v"}`, `{"deviceId":"d"} trailing`} {
		f.post(path, "test-key", body, 400)
	}
	for i := 0; i < 10; i++ {
		f.post(path, "test-key", payload, 200)
		if got := <-wakes; got != (Wake{testRoute, "d", "w", wakeText}) {
			t.Fatal("unexpected wake")
		}
	}
	f.post(path, "test-key", payload, 429)
	resp, err := f.h.Client().Get(f.h.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var health struct {
		OK                bool
		Version, Protocol string
		Stats             struct{ Routes, Clients int }
	}
	if json.NewDecoder(resp.Body).Decode(&health) != nil || !health.OK || health.Version != "1.0.0" || health.Protocol != protocol || health.Stats.Routes != 1 || health.Stats.Clients != 1 {
		t.Fatal("unexpected health")
	}
}

func TestSizeRateAndHeartbeat(t *testing.T) {
	f := start(t, Options{MaxFrameBytes: 256, Burst: 2, FramesPerSecond: 1})
	h := f.host()
	c := f.client(h, "d")
	f.write(c, fields{"t": "ping", "ts": 42})
	f.expect(c, "t", "pong")
	f.write(c, fields{"t": "ping"})
	f.expect(c, "code", "RATE_LIMITED")
	probe := f.socket()
	probe.CloseRead(f.ctx)
	if err := probe.Ping(f.ctx); err != nil {
		t.Fatal(err)
	}
	if err := c.Write(f.ctx, websocket.MessageText, bytes.Repeat([]byte("x"), 257)); err != nil {
		t.Fatal(err)
	}
	f.expect(c, "code", "FRAME_TOO_LARGE")
	f.closed(c, 1009)
	f.expect(h, "t", "peer.left")
}

func TestPairBudgetSharedAcrossSockets(t *testing.T) {
	f := start(t, Options{})
	h := f.host()
	a := f.client(h, "a")
	b := f.client(h, "b")
	m := fields{"t": "pair", "routeId": testRoute, "deviceId": "a", "payload": strings.Repeat("x", 16384)}
	f.write(a, m)
	f.expect(a, "code", "FRAME_TOO_LARGE")
	m["payload"] = nil
	for i := 0; i < 10; i++ {
		f.write(a, m)
		f.expect(h, "t", "pair")
	}
	m["deviceId"] = "b"
	f.write(b, m)
	f.expect(b, "code", "RATE_LIMITED")
}

func TestShutdownDrainsUpgradedConnections(t *testing.T) {
	f := start(t, Options{})
	h := f.host()
	c := f.client(h, "a")
	done := make(chan error, 1)
	go func() { done <- f.s.Shutdown(f.ctx) }()
	f.closed(h, 1001)
	f.closed(c, 1001)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
