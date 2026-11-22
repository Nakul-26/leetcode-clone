FROM python:3.10-alpine

# Precompile the standard library. The official image ships it without .pyc files, and the
# sandbox's root filesystem is read-only, so every run compiled each module it imported from
# source: ~110 ms per Python start for the wrapper's usual imports (138 -> 25 ms measured on
# deploy2, 2026-11-22). +27 MB.
RUN python -m compileall -q /usr/local/lib/python3.10 || true

# Create a non-root user 'judge'
RUN addgroup --system judge && adduser --system --ingroup judge judge

# Set the user
USER judge
