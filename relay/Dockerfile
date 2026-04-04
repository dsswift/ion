FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /relay .

FROM alpine:3.19
RUN apk add --no-cache ca-certificates
COPY --from=build /relay /relay
EXPOSE 8443
# mDNS uses UDP port 5353 for LAN discovery.
# Only relevant when running with --net=host or on bare metal.
EXPOSE 5353/udp
ENTRYPOINT ["/relay"]
