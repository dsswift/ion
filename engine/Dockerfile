FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags "-s -w" -o /ion ./cmd/ion/

FROM scratch
COPY --from=build /ion /ion
ENV HOME=/data
VOLUME ["/data"]
ENTRYPOINT ["/ion"]
CMD ["serve"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD ["/ion", "health"]
