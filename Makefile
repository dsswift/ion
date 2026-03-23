.PHONY: install

install:
	@pkill -9 -f "CODA" 2>/dev/null || true
	@sleep 1
	npm run dist
	@rm -rf "/Applications/CODA.app"
	@cp -R "release/mac-arm64/CODA.app" "/Applications/CODA.app"
	@echo "Installed to /Applications/CODA.app"
