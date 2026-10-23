# One Cadence runner per Railway service, serving the web app on the same origin.
# Built from the directory deploy/railway/stage.sh assembles (code and web/dist only).
FROM rust:1.96-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo build --release -p cadence-runner -p cadence-cli -p cadence-decode

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
RUN useradd --system --uid 10001 --create-home --home-dir /cadence cadence
COPY --from=build /src/target/release/cadence-runner /src/target/release/cadence /src/target/release/cadence-decode /usr/local/bin/
COPY web/dist /srv/web
COPY entrypoint.sh /usr/local/bin/cadence-entrypoint
WORKDIR /cadence
# Starts as root only to hand the volume to the runner's user, then drops to it.
ENTRYPOINT ["cadence-entrypoint"]
