# Linux userland for the dsh-edge Container runtime.
#
# computerd is the Cloudflare Computer daemon: it mounts the Durable Object's
# workspace at /workspace over FUSE, dials back to the Durable Object, and runs
# shell commands. Its version must match the @cloudflare/computer package the
# Worker bundles (the wire protocol has no negotiation), so bump both together.
# Both base images are pinned by digest.

FROM ghcr.io/cloudflare/computer-computerd-linux-x64:0.7.0@sha256:1b8068c6ff97471b2aead69d8fd18ae55b487db2b67cf0bc330795a3c99c495c AS computerd

FROM debian:stable-slim@sha256:5bc3287b25407c965a30f38e32603dc253a3869e1b12a21ac09bfc27fd8b13ce

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fuse3 libfuse2t64 ca-certificates curl gnupg git python3 ripgrep \
      bzip2 xz-utils zstd unzip zip jq make \
 && mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs \
 && apt-get purge -y --auto-remove gnupg \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd

# computerd serves HTTP and its RPC socket on :8080 and mounts the workspace at
# MOUNT_POINT. FUSE_MOUNT=auto uses real FUSE on Cloudflare Containers and a
# userspace shim under `wrangler dev`.
ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/computerd"]
