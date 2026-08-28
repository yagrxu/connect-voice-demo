# 方案 B Transcribe pipeline — container for AgentCore Runtime (or Fargate).
# ⚠️ Not yet built/pushed/deployed. See docs/latency-optimization-plan.md.
FROM public.ecr.aws/docker/library/python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

EXPOSE 8000
# WebSocket server; AgentCore Runtime / ALB front this on :8000.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
