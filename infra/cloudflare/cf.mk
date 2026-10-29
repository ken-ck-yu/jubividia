# UI / Cloudflare targets. Run from the repo root:
#   make -f infra/cloudflare/cf.mk test-ui
.PHONY: test-ui test-cloudflare lint-cloudflare

test-ui:
	cd ui && npm test

test-cloudflare:
	bash tests/cloudflare/run.sh

lint-cloudflare:
	bash -n infra/cloudflare/apply.sh
	bash -n infra/cloudflare/lib.sh
	bash -n tests/cloudflare/run.sh
	@if command -v shellcheck >/dev/null; then \
	  shellcheck -x -e SC1091 infra/cloudflare/apply.sh infra/cloudflare/lib.sh tests/cloudflare/run.sh; \
	else \
	  echo "shellcheck not installed: skipped (only bash -n ran)"; \
	fi
