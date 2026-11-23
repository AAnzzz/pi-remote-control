package main

import (
	"context"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/pi-remote/relay/internal/relay"
)

func env(k, fallback string) string {
	if value, ok := os.LookupEnv(k); ok {
		return value
	}
	return fallback
}

func run() error {
	port, err := strconv.Atoi(env("PORT", "8787"))
	if err != nil || port < 0 || port > 65535 {
		return errors.New("invalid port")
	}
	n, err := strconv.Atoi(env("MAX_FRAME_BYTES", "262144"))
	if err != nil || n < 1 || n > 16<<20 {
		return errors.New("invalid frame limit")
	}
	opts := relay.Options{MaxFrameBytes: n, RequireTickets: os.Getenv("REQUIRE_TICKETS") == "1"}
	if provider := os.Getenv("PUSH_WEBHOOK_URL"); provider != "" {
		u, err := url.ParseRequestURI(provider)
		if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
			return errors.New("invalid provider URL")
		}
		opts.Push = relay.Webhook(provider)
	}
	r := relay.New(opts)
	srv := &http.Server{Handler: r, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 8192, ErrorLog: log.New(io.Discard, "", 0)}
	ln, err := net.Listen("tcp", net.JoinHostPort(env("HOST", "0.0.0.0"), strconv.Itoa(port)))
	if err != nil {
		return errors.New("listener unavailable")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	done := make(chan error, 1)
	go func() { done <- srv.Serve(ln) }()
	log.Printf("pi-relay.v1 listening on port %d", ln.Addr().(*net.TCPAddr).Port)
	select {
	case <-ctx.Done():
	case err := <-done:
		return err
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	httpDone := make(chan error, 1)
	go func() { httpDone <- srv.Shutdown(shutdown) }()
	if err := r.Shutdown(shutdown); err != nil {
		return err
	}
	return <-httpDone
}

func main() {
	if err := run(); err != nil {
		log.Print("relay configuration, listener or shutdown failure")
		os.Exit(1)
	}
}
