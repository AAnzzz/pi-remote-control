// Package relay implements the in-memory pi-relay.v1 router. Network IO is never
// performed with the route lock held. Only the writer owns the outbound queue.
package relay

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"
)

const protocol = "pi-relay.v1"
const wakeText = "PI-Desktop 有更新"

type Wake struct {
	RouteID  string `json:"routeId"`
	DeviceID string `json:"deviceId"`
	WakeID   string `json:"wakeId"`
	Message  string `json:"message"`
}

type Options struct {
	MaxFrameBytes   int
	Heartbeat       time.Duration
	Burst           int
	FramesPerSecond int
	RequireTickets  bool
	Push            func(context.Context, Wake) error
}

type bucket struct {
	capacity, rate, tokens float64
	last                   time.Time
}

func newBucket(n int, perSecond float64) bucket {
	return bucket{float64(n), perSecond, float64(n), time.Now()}
}

func (b *bucket) take() bool {
	now := time.Now()
	b.tokens = math.Min(b.capacity, b.tokens+now.Sub(b.last).Seconds()*b.rate)
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

type route struct {
	id          string
	hash        []byte
	host        *peer
	clients     map[string]*peer
	tickets     map[[32]byte]time.Time
	locked      bool
	wake, issue bucket
}

type terminal struct {
	code   websocket.StatusCode
	reason string
	last   []byte
}

type peer struct {
	conn       *websocket.Conn
	ip, device string
	out        chan []byte
	end        chan terminal
	started    time.Time
	// Fields below and device are guarded by Server.mu.
	r       *route
	closing bool
	queued  int
	limit   bucket
}

type Server struct {
	opts      Options
	mu        sync.Mutex
	routes    map[string]*route
	peers     map[*peer]bool
	ips       map[string]*bucket
	nextSweep time.Time
	stopping  bool
	wg        sync.WaitGroup
}

func New(o Options) *Server {
	if o.MaxFrameBytes == 0 {
		o.MaxFrameBytes = 262144
	}
	if o.Heartbeat == 0 {
		o.Heartbeat = 25 * time.Second
	}
	if o.Burst == 0 {
		o.Burst = 120
	}
	if o.FramesPerSecond == 0 {
		o.FramesPerSecond = 60
	}
	if o.MaxFrameBytes < 1 || o.MaxFrameBytes > 16<<20 || o.Heartbeat < time.Millisecond || o.Heartbeat > time.Hour || o.Burst < 1 || o.FramesPerSecond < 1 {
		panic("invalid relay limits")
	}
	return &Server{opts: o, routes: make(map[string]*route), peers: make(map[*peer]bool), ips: make(map[string]*bucket)}
}

type fields = map[string]any
type rawMap map[string]json.RawMessage

func outer(b []byte) (rawMap, bool) {
	if !utf8.Valid(b) {
		return nil, false
	}
	d := json.NewDecoder(bytes.NewReader(b))
	t, err := d.Token()
	if err != nil || t != json.Delim('{') {
		return nil, false
	}
	m := make(rawMap)
	for d.More() {
		k, err := d.Token()
		if err != nil {
			return nil, false
		}
		key, ok := k.(string)
		if !ok {
			return nil, false
		}
		if _, dup := m[key]; dup {
			return nil, false
		}
		var v json.RawMessage
		if d.Decode(&v) != nil {
			return nil, false
		}
		m[key] = v
	}
	t, err = d.Token()
	if err != nil || t != json.Delim('}') {
		return nil, false
	}
	_, err = d.Token()
	return m, err == io.EOF
}

func (m rawMap) str(k string) string {
	var s string
	_ = json.Unmarshal(m[k], &s)
	return s
}

var validID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`).MatchString
var messages = map[string]string{
	"BAD_FRAME": "Invalid frame", "ROUTE_NOT_FOUND": "Peer not online", "UNAUTHORIZED": "Unauthorized", "RATE_LIMITED": "Rate limited", "REVOKED": "Device revoked by host", "FRAME_TOO_LARGE": "Frame too large", "PUSH_FAILED": "Wake dispatch failed",
}

func fault(code string) fields { return fields{"t": "error", "code": code, "message": messages[code]} }
func encode(v any) []byte      { b, _ := json.Marshal(v); return b }
func reply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(encode(v))
}

func (s *Server) ServeHTTP(w http.ResponseWriter, q *http.Request) {
	switch {
	case q.Method == "GET" && q.URL.Path == "/ws":
		s.socket(w, q)
	case q.Method == "GET" && q.URL.Path == "/healthz":
		s.mu.Lock()
		online, clients := 0, 0
		for _, r := range s.routes {
			if r.host != nil {
				online++
			}
			clients += len(r.clients)
		}
		s.mu.Unlock()
		reply(w, 200, fields{"ok": true, "version": "1.0.0", "protocol": protocol, "stats": fields{"routes": online, "clients": clients}})
	case q.Method == "POST" && (q.URL.Path == "/v1/tickets" || q.URL.Path == "/v1/push/wake"):
		s.post(w, q)
	default:
		reply(w, 404, fault("ROUTE_NOT_FOUND"))
	}
}

func (s *Server) post(w http.ResponseWriter, q *http.Request) {
	key := q.Header.Get("X-Host-Secret")
	hash := sha256.Sum256([]byte(key))
	s.mu.Lock()
	r := s.routes[q.Header.Get("X-Route-Id")]
	ok := key != "" && r != nil && r.host != nil && subtle.ConstantTimeCompare(hash[:], r.hash) == 1
	s.mu.Unlock()
	if !ok {
		reply(w, 401, fault("UNAUTHORIZED"))
		return
	}
	b, err := io.ReadAll(io.LimitReader(q.Body, 4097))
	if err != nil {
		reply(w, 400, fault("BAD_FRAME"))
		return
	}
	if len(b) > 4096 {
		reply(w, 413, fault("FRAME_TOO_LARGE"))
		return
	}
	ticket := q.URL.Path == "/v1/tickets"
	if ticket && len(b) == 0 {
		b = []byte("{}")
	}
	m, ok := outer(b)
	if !ok {
		reply(w, 400, fault("BAD_FRAME"))
		return
	}
	s.mu.Lock()
	if r.host == nil {
		s.mu.Unlock()
		reply(w, 401, fault("UNAUTHORIZED"))
		return
	}
	if ticket {
		if len(m) != 0 {
			s.mu.Unlock()
			reply(w, 400, fault("BAD_FRAME"))
			return
		}
		now := time.Now()
		for k, exp := range r.tickets {
			if !exp.After(now) {
				delete(r.tickets, k)
			}
		}
		if len(r.tickets) >= 128 || !r.issue.take() {
			s.mu.Unlock()
			reply(w, 429, fault("RATE_LIMITED"))
			return
		}
		var key [32]byte
		if _, err := rand.Read(key[:]); err != nil {
			s.mu.Unlock()
			reply(w, 503, fault("RATE_LIMITED"))
			return
		}
		token := base64.RawURLEncoding.EncodeToString(key[:])
		exp := now.Add(120 * time.Second)
		r.tickets[sha256.Sum256([]byte(token))] = exp
		r.locked = true
		s.mu.Unlock()
		reply(w, 200, fields{"joinToken": token, "expiresAt": exp.UnixMilli()})
		return
	}
	device, wake := m.str("deviceId"), m.str("wakeId")
	if len(m) != 2 || !validID(device) || !validID(wake) {
		s.mu.Unlock()
		reply(w, 400, fault("BAD_FRAME"))
		return
	}
	ok = r.wake.take()
	s.mu.Unlock()
	if !ok {
		reply(w, 429, fault("RATE_LIMITED"))
		return
	}
	if s.opts.Push != nil {
		ctx, cancel := context.WithTimeout(q.Context(), 5*time.Second)
		defer cancel()
		if s.opts.Push(ctx, Wake{r.id, device, wake, wakeText}) != nil {
			reply(w, 502, fault("PUSH_FAILED"))
			return
		}
	}
	reply(w, 200, fields{"ok": true})
}

func Webhook(url string) func(context.Context, Wake) error {
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return func(ctx context.Context, wake Wake) error {
		req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(encode(wake)))
		if err != nil {
			return err
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if resp.StatusCode/100 != 2 {
			return errors.New("provider unavailable")
		}
		return nil
	}
}

// All mutation/queue helpers below are called with mu held. A terminal command
// has its own reserved slot, so revocation cannot sit behind a full data queue.
func (s *Server) stop(p *peer, end terminal) {
	if !p.closing {
		p.closing = true
		p.end <- end
	}
}
func (s *Server) queue(p *peer, b []byte) bool {
	if p == nil || p.closing {
		return false
	}
	if p.queued+len(b) <= max(65536, 4*s.opts.MaxFrameBytes) {
		select {
		case p.out <- b:
			p.queued += len(b)
			return true
		default:
		}
	}
	s.stop(p, terminal{1013, "slow reader", nil})
	return false
}
func (s *Server) send(p *peer, m fields) {
	if p != nil {
		s.queue(p, encode(m))
	}
}
func (s *Server) detach(p *peer) {
	r := p.r
	if r == nil {
		return
	}
	p.r = nil
	if r.host == p {
		r.host = nil
		for _, c := range r.clients {
			s.send(c, fields{"t": "peer.left", "routeId": r.id, "role": "host"})
		}
	} else if r.clients[p.device] == p {
		delete(r.clients, p.device)
		s.send(r.host, fields{"t": "peer.left", "routeId": r.id, "deviceId": p.device, "role": "client"})
	}
}

var protocolToken = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$").MatchString

func (s *Server) socket(w http.ResponseWriter, q *http.Request) {
	if offered := q.Header.Values("Sec-WebSocket-Protocol"); len(offered) != 0 {
		seen := make(map[string]bool)
		for _, v := range strings.Split(strings.Join(offered, ","), ",") {
			token := strings.TrimSpace(v)
			if seen[token] || !protocolToken(token) {
				http.Error(w, "invalid protocol", 400)
				return
			}
			seen[token] = true
		}
		if !seen[protocol] {
			http.Error(w, "unsupported protocol", 400)
			return
		}
	}
	ip, _, _ := net.SplitHostPort(q.RemoteAddr)
	p := &peer{ip: ip, out: make(chan []byte, 128), end: make(chan terminal, 1), started: time.Now(), limit: newBucket(s.opts.Burst, float64(s.opts.FramesPerSecond))}
	s.mu.Lock()
	if s.stopping || len(s.peers) >= 4096 {
		s.mu.Unlock()
		http.Error(w, "unavailable", 503)
		return
	}
	s.peers[p] = true
	s.wg.Add(1)
	s.mu.Unlock()
	defer func() { s.mu.Lock(); s.detach(p); delete(s.peers, p); s.mu.Unlock(); s.wg.Done() }()
	// Cross-origin web companions are supported. No cookie-based authentication.
	c, err := websocket.Accept(w, q, &websocket.AcceptOptions{Subprotocols: []string{protocol}, InsecureSkipVerify: true})
	if err != nil {
		return
	}
	p.conn = c
	defer c.CloseNow()
	// Limit the decompressed stream ourselves so we can send FRAME_TOO_LARGE
	// before the 1009 close. Compression is disabled, including on upgrade.
	c.SetReadLimit(-1)
	ctx, cancel := context.WithCancel(q.Context())
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); s.writer(ctx, p) }()
	// Pinging must not block the writer, especially REVOKED + close(4003).
	beatDone := make(chan struct{})
	go func() { defer close(beatDone); s.heartbeat(ctx, p) }()
	defer func() { cancel(); <-beatDone }()
	for {
		kind, rd, err := c.Reader(ctx)
		if err != nil {
			break
		}
		var end *terminal
		if kind != websocket.MessageText {
			end = &terminal{1003, "", nil}
		} else {
			b, err := io.ReadAll(io.LimitReader(rd, int64(s.opts.MaxFrameBytes)+1))
			if err != nil {
				break
			}
			switch {
			case len(b) > s.opts.MaxFrameBytes:
				end = &terminal{1009, "", encode(fault("FRAME_TOO_LARGE"))}
			case !utf8.Valid(b):
				end = &terminal{1007, "", nil}
			default:
				s.receive(p, b)
			}
		}
		if end != nil {
			s.mu.Lock()
			s.stop(p, *end)
			s.mu.Unlock()
			<-done
			return
		}
	}
	cancel()
	<-done
}

func (s *Server) writer(ctx context.Context, p *peer) {
	defer p.conn.CloseNow()
	write := func(b []byte) error {
		c, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		return p.conn.Write(c, websocket.MessageText, b)
	}
	finish := func(e terminal) {
		if e.last != nil {
			_ = write(e.last)
		}
		_ = p.conn.Close(e.code, e.reason)
	}
	for {
		select {
		case e := <-p.end:
			finish(e)
			return
		default:
		}
		select {
		case <-ctx.Done():
			return
		case e := <-p.end:
			finish(e)
			return
		case b := <-p.out:
			s.mu.Lock()
			p.queued -= len(b)
			closing := p.closing
			s.mu.Unlock()
			if !closing && write(b) != nil {
				return
			}
		}
	}
}

func (s *Server) heartbeat(ctx context.Context, p *peer) {
	tick := time.NewTicker(s.opts.Heartbeat)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		s.mu.Lock()
		idle := p.r == nil && time.Since(p.started) >= 2*s.opts.Heartbeat
		closing := p.closing
		s.mu.Unlock()
		if closing {
			return
		}
		if idle {
			p.conn.CloseNow()
			return
		}
		c, cancel := context.WithTimeout(ctx, s.opts.Heartbeat)
		err := p.conn.Ping(c)
		cancel()
		if err != nil {
			p.conn.CloseNow()
			return
		}
	}
}

func (s *Server) pairAllowed(ip string) bool {
	now := time.Now()
	if !now.Before(s.nextSweep) {
		for k, b := range s.ips {
			if now.Sub(b.last) >= time.Minute {
				delete(s.ips, k)
			}
		}
		s.nextSweep = now.Add(time.Minute)
	}
	b := s.ips[ip]
	if b == nil {
		if len(s.ips) >= 16384 {
			return false
		}
		v := newBucket(10, 10.0/60)
		b = &v
		s.ips[ip] = b
	}
	return b.take()
}

func (s *Server) receive(p *peer, b []byte) {
	s.mu.Lock()
	limited := !p.limit.take()
	if limited {
		s.send(p, fault("RATE_LIMITED"))
	}
	s.mu.Unlock()
	if limited {
		return
	}
	m, ok := outer(b)
	typ, rid, device := m.str("t"), m.str("routeId"), m.str("deviceId")
	s.mu.Lock()
	defer s.mu.Unlock()
	if p.closing {
		return
	}
	reject := func(code string) { s.send(p, fault(code)) }
	if !ok {
		reject("BAD_FRAME")
		return
	}
	if typ == "ping" || typ == "pong" {
		msg := fields{"t": "pong"}
		if raw, has := m["ts"]; has {
			var n float64
			if string(raw) == "null" || json.Unmarshal(raw, &n) != nil || math.Abs(n) > 9007199254740991 || n != math.Trunc(n) {
				reject("BAD_FRAME")
				return
			}
			msg["ts"] = n
		}
		if typ == "ping" {
			s.send(p, msg)
		}
		return
	}
	if len(rid) < 16 || !validID(rid) {
		reject("BAD_FRAME")
		return
	}
	r := s.routes[rid]
	if typ == "host.register" {
		if p.r != nil {
			reject("UNAUTHORIZED")
			return
		}
		hash, err := hex.DecodeString(m.str("hostSecretHash"))
		if err != nil || len(hash) != 32 || !validID(m.str("hostId")) {
			reject("BAD_FRAME")
			return
		}
		if r != nil && subtle.ConstantTimeCompare(hash, r.hash) != 1 {
			reject("UNAUTHORIZED")
			return
		}
		if r == nil {
			if len(s.routes) >= 4096 {
				reject("RATE_LIMITED")
				return
			}
			r = &route{id: rid, hash: hash, clients: make(map[string]*peer), tickets: make(map[[32]byte]time.Time), locked: s.opts.RequireTickets, wake: newBucket(10, 10.0/60), issue: newBucket(30, 1)}
			s.routes[rid] = r
		}
		if old := r.host; old != nil {
			s.detach(old)
			s.stop(old, terminal{4001, "replaced", nil})
		}
		r.host = p
		p.r = r
		s.send(p, fields{"t": "host.registered", "routeId": rid, "maxFrameBytes": s.opts.MaxFrameBytes, "heartbeatMs": s.opts.Heartbeat.Milliseconds()})
		for d, c := range r.clients {
			s.send(c, fields{"t": "peer.joined", "routeId": rid, "role": "host", "hostOnline": true})
			s.send(p, fields{"t": "peer.joined", "routeId": rid, "deviceId": d, "hostOnline": true})
		}
		return
	}
	if typ == "client.join" {
		if p.r != nil {
			reject("UNAUTHORIZED")
			return
		}
		if !validID(device) {
			reject("BAD_FRAME")
			return
		}
		if r == nil || r.host == nil {
			reject("ROUTE_NOT_FOUND")
			return
		}
		if _, has := m["joinToken"]; has || r.locked {
			token := m.str("joinToken")
			if len(token) != 43 || !validID(token) {
				reject("UNAUTHORIZED")
				return
			}
			k := sha256.Sum256([]byte(token))
			exp := r.tickets[k]
			delete(r.tickets, k)
			if !time.Now().Before(exp) {
				reject("UNAUTHORIZED")
				return
			}
		}
		if old := r.clients[device]; old != nil {
			s.detach(old)
			s.stop(old, terminal{4001, "replaced", nil})
		}
		r.clients[device] = p
		p.r = r
		p.device = device
		msg := fields{"t": "client.joined", "routeId": rid, "deviceId": device, "hostOnline": true}
		s.send(p, msg)
		msg["t"] = "peer.joined"
		s.send(r.host, msg)
		return
	}
	if r == nil || p.r != r {
		reject("UNAUTHORIZED")
		return
	}
	if !validID(device) {
		reject("BAD_FRAME")
		return
	}
	host := r.host == p
	other := r.clients[device]
	if !host {
		if device != p.device || other != p {
			reject("UNAUTHORIZED")
			return
		}
		other = r.host
	}
	switch typ {
	case "host.revoke":
		if !host {
			reject("UNAUTHORIZED")
			return
		}
		if other == nil {
			reject("ROUTE_NOT_FOUND")
			return
		}
		s.detach(other)
		s.stop(other, terminal{4003, "revoked", encode(fault("REVOKED"))})
		return
	case "pair":
		if len(b) > 16384 {
			reject("FRAME_TOO_LARGE")
			return
		}
		if len(m) != 4 || m["payload"] == nil {
			reject("BAD_FRAME")
			return
		}
		if !s.pairAllowed(p.ip) {
			reject("RATE_LIMITED")
			return
		}
	case "cipher":
		env := m["envelope"]
		if len(m) != 5 || !validID(m.str("frameId")) || len(env) == 0 || env[0] != '{' {
			reject("BAD_FRAME")
			return
		}
	default:
		reject("BAD_FRAME")
		return
	}
	if !s.queue(other, b) {
		reject("ROUTE_NOT_FOUND")
	}
}

// Shutdown also drains upgraded connections (http.Server.Shutdown does not).
func (s *Server) Shutdown(ctx context.Context) error {
	s.mu.Lock()
	s.stopping = true
	for p := range s.peers {
		s.stop(p, terminal{1001, "shutdown", nil})
	}
	s.mu.Unlock()
	done := make(chan struct{})
	go func() { s.wg.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
