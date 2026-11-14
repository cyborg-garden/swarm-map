# The lab's two images. Built once, with the network, by
# `npm run conformance:docker:build`. A test run never builds and never pulls.
#
#   cell   the harness, its shim and its gate, and the lab's probe. One stage
#          per harness: `cell` holds Pi, `cell-letta-code` holds Letta Code
#   rig    the sidecar's side (door, model route, scripted model), the sink
#          and the control
#
# These are test images. Nothing here is a product image and nothing is pushed.
# The build context is the repo root, cut down by Dockerfile.dockerignore to
# the lab's own folders.

FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS base
# The folder the two sides share is made here, owned by the user both run as,
# so the volume mounted over it starts out the same way.
RUN mkdir -p /tmp/smlab /opt/swarm && chown node:node /tmp/smlab

FROM base AS cell
# The harness, pinned by version and by the integrity hash of every package in
# the lock file. No install script of any package is run.
COPY conformance/docker/pi/package.json conformance/docker/pi/package-lock.json /opt/pi/
RUN cd /opt/pi && npm ci --ignore-scripts --omit=dev --no-audit --no-fund \
 && ln -s /opt/pi/node_modules/.bin/pi /usr/local/bin/pi \
 && rm -rf /root/.npm
COPY lib/core /opt/swarm/lib/core
COPY lib/door/framing.ts lib/door/protocol.ts lib/door/shim-client.ts /opt/swarm/lib/door/
COPY lib/runtimes/pi /opt/swarm/lib/runtimes/pi
COPY conformance/guards/preflight.ts /opt/swarm/conformance/guards/
COPY conformance/broken/gate-allows-all.ts /opt/swarm/conformance/broken/
COPY conformance/docker/cell-main.ts conformance/docker/probe.ts conformance/docker/report.ts conformance/docker/compose.ts /opt/swarm/conformance/docker/
# Owned by root and not writable by anyone. The cell also runs on a read-only disk.
RUN chmod -R a-w /opt/swarm /opt/pi
USER node
WORKDIR /tmp/smlab

FROM base AS cell-letta-code
# The second harness, built the same way: pinned by version and by the
# integrity hash of every package in its lock file, with no install script run.
# Letta Code keeps its memory in a git repository and will not start without
# git, so this cell holds git, at one named version.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git=1:2.39.5-0+deb12u3 \
 && rm -rf /var/lib/apt/lists/*
COPY conformance/docker/letta-code/package.json conformance/docker/letta-code/package-lock.json /opt/letta-code/
RUN cd /opt/letta-code && npm ci --ignore-scripts --omit=dev --no-audit --no-fund \
 && ln -s /opt/letta-code/node_modules/.bin/letta /usr/local/bin/letta \
 && rm -rf /root/.npm
COPY lib/core /opt/swarm/lib/core
COPY lib/door/framing.ts lib/door/protocol.ts lib/door/shim-client.ts /opt/swarm/lib/door/
COPY lib/runtimes/letta-code /opt/swarm/lib/runtimes/letta-code
# The two files of Pi's that this cell also reads: how a sender is framed in a prompt, and a version the rig file names.
COPY lib/runtimes/pi/preamble.ts lib/runtimes/pi/caps.ts /opt/swarm/lib/runtimes/pi/
COPY conformance/guards/preflight.ts /opt/swarm/conformance/guards/
COPY conformance/broken/letta-code-wrapped.ts /opt/swarm/conformance/broken/
COPY conformance/docker/probe.ts conformance/docker/report.ts conformance/docker/compose.ts /opt/swarm/conformance/docker/
COPY conformance/docker/letta-code/cell-main.ts /opt/swarm/conformance/docker/letta-code/
RUN chmod -R a-w /opt/swarm /opt/letta-code
USER node
WORKDIR /tmp/smlab

FROM base AS rig
COPY lib/core /opt/swarm/lib/core
COPY lib/door /opt/swarm/lib/door
COPY lib/runtimes /opt/swarm/lib/runtimes
COPY conformance /opt/swarm/conformance
RUN chmod -R a-w /opt/swarm
USER node
WORKDIR /opt/swarm
