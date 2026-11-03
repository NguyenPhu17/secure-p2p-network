FROM python:3.12-slim

WORKDIR /app

# Install curl for diagnostics
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# Install python dependencies
COPY peer_node/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy shared modules and peer_node source code
COPY shared /app/shared
COPY peer_node /app/peer_node

WORKDIR /app/peer_node
ENV PYTHONPATH=/app

HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request, os; p = os.getenv('PORT', '8001'); urllib.request.urlopen(f'http://localhost:{p}/health')" || exit 1

CMD ["python", "main.py"]

