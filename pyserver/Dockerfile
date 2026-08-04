FROM python:3.13-slim
WORKDIR /app
# tzdata ensures TZ=Asia/Shanghai is respected by datetime.now()/date.today().
RUN apt-get update && apt-get install -y --no-install-recommends tzdata && rm -rf /var/lib/apt/lists/*
COPY pyproject.toml uv.lock ./
RUN pip install --no-cache-dir uv && uv sync --frozen --no-dev
COPY main.py mock_data.py cache.py validation.py analyst.py ./
# Empty token = free live sources (akshare/baostock); set "mock" only for demos/tests.
ENV TUSHARE_TOKEN=""
ENV TZ=Asia/Shanghai
EXPOSE 8001
# python:3.13-slim has no curl/wget; use stdlib urllib. docker-compose.yml
# overrides this with the same check — keep both in sync.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8001/health', timeout=5).status==200 else 1)"
CMD ["uv", "run", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]
