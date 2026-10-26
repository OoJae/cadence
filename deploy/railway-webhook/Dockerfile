# The sandbox's test merchant endpoint: scripts/webhook-echo.py, which checks both
# signatures (X-Cadence-Signature and CipherPay's) and logs each event. It listens
# on Railway's private network only; it has no public domain.
FROM python:3.12-alpine
COPY webhook-echo.py /app/webhook-echo.py
USER 10001:10001
ENV ECHO_HOST=::
CMD ["python3", "-u", "-I", "/app/webhook-echo.py"]
