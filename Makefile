.PHONY: install

install:
	@pkill -9 -f "Clui CC" 2>/dev/null || true
	@sleep 1
	npm run dist
	@rm -rf "/Applications/Clui CC.app"
	@cp -R "release/mac-arm64/Clui CC.app" "/Applications/Clui CC.app"
	@echo "Installed to /Applications/Clui CC.app"
