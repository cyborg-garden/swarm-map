# The lab's two images. Built once, with the network, by
# `npm run conformance:docker:build`. A test run never builds and never pulls.
#
#   cell   the harness, its shim and its gate, and the lab's probe. One stage
#          per harness: `cell` holds Pi, `cell-letta-code` holds Letta Code,
#          `cell-claude-sdk` holds the Claude Agent SDK, `cell-opencode` holds
#          OpenCode
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
# The gates that are broken on purpose. A cell loads one only when its rig names it.
COPY conformance/broken/gate-allows-all.ts conformance/broken/gate-silence-is-yes.ts conformance/broken/gate-runs-more.ts conformance/broken/gate-no-path-check.ts conformance/broken/gate-no-limits.ts /opt/swarm/conformance/broken/
COPY conformance/docker/cell-main.ts conformance/docker/probe.ts conformance/docker/report.ts conformance/docker/compose.ts conformance/docker/subnets.ts /opt/swarm/conformance/docker/
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
COPY conformance/docker/probe.ts conformance/docker/report.ts conformance/docker/compose.ts conformance/docker/subnets.ts /opt/swarm/conformance/docker/
COPY conformance/docker/letta-code/cell-main.ts /opt/swarm/conformance/docker/letta-code/
RUN chmod -R a-w /opt/swarm /opt/letta-code
USER node
WORKDIR /tmp/smlab

FROM base AS cell-claude-sdk
# The third harness, built the same way: pinned by version and by the
# integrity hash of every package in its lock file, with no install script run.
# The SDK is a JavaScript package and a Claude Code program for this platform,
# which the package starts. The lock file names the program for every
# platform; npm installs the one that fits this image.
COPY conformance/docker/claude-sdk/package.json conformance/docker/claude-sdk/package-lock.json /opt/claude-sdk/
RUN cd /opt/claude-sdk && npm ci --ignore-scripts --omit=dev --no-audit --no-fund \
 && ln -s "$(ls /opt/claude-sdk/node_modules/@anthropic-ai/claude-agent-sdk-*/claude)" /usr/local/bin/claude \
 && rm -rf /root/.npm
COPY lib/core /opt/swarm/lib/core
COPY lib/door/framing.ts lib/door/protocol.ts lib/door/shim-client.ts /opt/swarm/lib/door/
COPY lib/runtimes/claude-sdk /opt/swarm/lib/runtimes/claude-sdk
# The two files of Pi's that this cell also reads: how a sender is framed in a prompt, and a version the rig file names.
COPY lib/runtimes/pi/preamble.ts lib/runtimes/pi/caps.ts /opt/swarm/lib/runtimes/pi/
# The guard, and the two files the broken SDK below reads to send a request the way the SDK would.
COPY conformance/guards/preflight.ts conformance/guards/watch-proxy.ts conformance/guards/tripwire.ts /opt/swarm/conformance/guards/
COPY conformance/broken/claude-sdk-wrapped.ts /opt/swarm/conformance/broken/
COPY conformance/docker/probe.ts conformance/docker/report.ts conformance/docker/compose.ts conformance/docker/subnets.ts /opt/swarm/conformance/docker/
COPY conformance/docker/claude-sdk/cell-main.ts conformance/docker/claude-sdk/version.ts /opt/swarm/conformance/docker/claude-sdk/
RUN chmod -R a-w /opt/swarm /opt/claude-sdk
USER node
WORKDIR /tmp/smlab

FROM base AS cell-opencode
# The fourth harness, built the same way: pinned by version and by the
# integrity hash of every package in its lock file, with no install script run.
# The package is a launcher and one compiled OpenCode program per platform. The
# lock file names every platform; npm installs those that fit this image, and
# the plain glibc build for this machine's architecture is the one linked.
COPY conformance/docker/opencode/package.json conformance/docker/opencode/package-lock.json /opt/opencode/
RUN cd /opt/opencode && npm ci --ignore-scripts --omit=dev --no-audit --no-fund \
 && bin="$(ls -d /opt/opencode/node_modules/opencode-linux-*/bin/opencode | grep -v -e musl -e baseline | head -n 1)" \
 && test -n "$bin" && ln -s "$bin" /usr/local/bin/opencode \
 && rm -rf /root/.npm
COPY lib/core /opt/swarm/lib/core
COPY lib/door/framing.ts lib/door/protocol.ts lib/door/shim-client.ts /opt/swarm/lib/door/
COPY lib/runtimes/acp /opt/swarm/lib/runtimes/acp
COPY lib/runtimes/opencode /opt/swarm/lib/runtimes/opencode
# The two files of Pi's that this cell also reads: how a sender is framed in a prompt, and a version the rig file names.
COPY lib/runtimes/pi/preamble.ts lib/runtimes/pi/caps.ts /opt/swarm/lib/runtimes/pi/
COPY conformance/guards/preflight.ts /opt/swarm/conformance/guards/
COPY conformance/broken/opencode-wrapped.ts /opt/swarm/conformance/broken/
COPY conformance/docker/probe.ts conformance/docker/report.ts conformance/docker/compose.ts conformance/docker/subnets.ts /opt/swarm/conformance/docker/
COPY conformance/docker/opencode/cell-main.ts /opt/swarm/conformance/docker/opencode/
RUN chmod -R a-w /opt/swarm /opt/opencode
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
