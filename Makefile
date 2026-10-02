.PHONY: install
install:
	pnpm install --frozen-lockfile

.PHONY: format
format:
	./scripts/format.sh

.PHONY: format-check
format-check:
	./scripts/format.sh --check

.PHONY: lint
lint:
	./scripts/lint.sh

.PHONY: typecheck
typecheck:
	pnpm exec tsc --noEmit

.PHONY: test
test: typecheck
	pnpm test

.PHONY: build
build:
	pnpm run build

.PHONY: codegen
codegen:
	pnpm run codegen

.PHONY: check-package
check-package:
	./scripts/check-package.sh

.PHONY: check-generated
check-generated:
	./scripts/check-generated.sh

.PHONY: release
release:
	pnpm run release
