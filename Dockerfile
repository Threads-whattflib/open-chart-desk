# open-chart-desk：一個映像檔包前端 + 後端。資料（K 線快取、畫線、自選清單、提醒）在 /app/data，要掛 volume。
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY server/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt \
 && useradd --create-home --uid 1000 app \
 && mkdir -p /app/data && chown app:app /app/data
COPY --chown=app:app server/ /app/server/
COPY --from=web --chown=app:app /web/dist/ /app/web/dist/
USER app
WORKDIR /app/server
EXPOSE 8510
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD python -c "import os,urllib.request,base64;r=urllib.request.Request('http://127.0.0.1:8510/api/config');p=os.environ.get('AUTH_PASSWORD');p and r.add_header('Authorization','Basic '+base64.b64encode(f\"{os.environ.get('AUTH_USER','admin')}:{p}\".encode()).decode());urllib.request.urlopen(r,timeout=8)"
CMD ["python", "-u", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8510"]
