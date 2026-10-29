-include config.env
IMAGE ?= ghcr.io/ken-ck-yu/ltx25-worker
TAG ?= dev
VENV := .venv
PY := $(VENV)/bin/python

.PHONY: help venv lint test build smoke
help:
	@echo "make test   - handler unit tests (no GPU, no network)"
	@echo "make lint   - ruff + yaml check on worker/ and tests/"
	@echo "make build  - docker build worker image ($(IMAGE):$(TAG))"
	@echo "make smoke  - run image-level checks inside the built image (no GPU)"

$(VENV)/.ok: Makefile
	python3 -m venv $(VENV)
	$(VENV)/bin/pip install -q pytest boto3 requests pyyaml ruff
	touch $@

venv: $(VENV)/.ok

lint: venv
	$(VENV)/bin/ruff check --select E,F,W --ignore E501 worker tests
	$(PY) -c "import yaml,sys; [yaml.safe_load(open(f)) for f in ('worker/extra_model_paths.yaml','.github/workflows/build-worker.yml')]"

test: venv
	$(VENV)/bin/pytest -q tests

build:
	docker build -t $(IMAGE):$(TAG) worker

smoke:
	docker run --rm --entrypoint /opt/venv/bin/python \
	  -v "$(CURDIR)/tests/smoke_image.py:/smoke_image.py:ro" $(IMAGE):$(TAG) /smoke_image.py
