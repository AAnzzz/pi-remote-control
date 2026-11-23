FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download github.com/coder/websocket
COPY cmd/ cmd/
COPY internal/ internal/
RUN CGO_ENABLED=0 go build -mod=readonly -trimpath -ldflags='-s -w' -o /relay ./cmd/relay

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /relay /relay
USER 65532:65532
EXPOSE 8787
ENTRYPOINT ["/relay"]
