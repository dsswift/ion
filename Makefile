.PHONY: install relay relay-local

install:
	@bash commands/install-bg.command

relay:
	docker build --platform linux/amd64 -t coda-relay:latest relay/

# Run the relay natively for local dev. Generates a random API key,
# prints it, and starts the relay with mDNS discovery on the host network.
relay-local:
	$(eval export RELAY_API_KEY ?= dev)
	@echo ""
	@echo "  RELAY_API_KEY=$(RELAY_API_KEY)"
	@echo ""
	cd relay && go run .
