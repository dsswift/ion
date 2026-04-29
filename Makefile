.PHONY: default desktop engine relay relay-local ios ios-check test clean

default: engine

engine:
	@cd engine && bash commands/install.command --standalone || { echo "❌ Engine build failed"; exit 1; }

desktop:
	@cd desktop && bash commands/install-bg.command

relay:
	@cd relay && docker build --platform linux/amd64 -t ion-relay:latest .

relay-local:
	@cd relay && go run .

ios:
	@cd ios && bash commands/install.command

ios-check:
	@cd ios && xcodebuild -project IonRemote.xcodeproj -scheme IonRemote \
		-destination 'generic/platform=iOS' build 2>&1 | grep -E "error:|BUILD"

test:
	@cd engine && go test ./...
	@cd desktop && npm test 2>/dev/null || true

clean:
	@cd engine && rm -rf bin/ dist/
	@cd desktop && rm -rf dist/ out/

# Local pipeline testing (requires: brew install act)
test-pipeline-dry:
	act workflow_dispatch -W .github/workflows/build.yml \
		--input release_report="$$(cat .act/release-report.json)" \
		--dryrun

test-pipeline-engine:
	act workflow_dispatch -W .github/workflows/build.yml \
		-j build-engine \
		--input release_report="$$(cat .act/release-report.json)"

test-pipeline-relay:
	act workflow_dispatch -W .github/workflows/build.yml \
		-j build-relay \
		--input release_report="$$(cat .act/release-report.json)"
