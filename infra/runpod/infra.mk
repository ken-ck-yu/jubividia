# Endpoint infra targets. Run from the repo root:
#   make -f infra/runpod/infra.mk test-infra
# Kept out of the root Makefile on purpose. The tests talk only to a fake server on 127.0.0.1.
.PHONY: test-infra lint-infra

test-infra:
	bash tests/infra/run.sh

lint-infra:
	bash -n infra/runpod/apply.sh
	bash -n infra/runpod/lib.sh
	bash -n scripts/smoke-job.sh
	@if command -v shellcheck >/dev/null; then \
	  shellcheck -x -e SC1091 infra/runpod/apply.sh infra/runpod/lib.sh scripts/smoke-job.sh; \
	else \
	  echo "shellcheck not installed: skipped (only bash -n ran). Install: pip install shellcheck-py"; \
	fi
