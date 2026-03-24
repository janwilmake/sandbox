FROM node:22-bookworm

# Copy the sandbox binary that provides the SDK HTTP API on port 3000
COPY --from=docker.io/cloudflare/sandbox:0.7.20 /container-server/sandbox /sandbox

RUN apt-get update && apt-get install -y \
    curl git jq unzip \
    && rm -rf /var/lib/apt/lists/*

# gh CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Wrangler
RUN npm install -g wrangler

# Stripe CLI
RUN curl -fsSL https://packages.stripe.dev/api/security/keypair/stripe-cli-gpg/public \
      | gpg --dearmor | tee /usr/share/keyrings/stripe.gpg > /dev/null \
    && echo "deb [signed-by=/usr/share/keyrings/stripe.gpg] https://packages.stripe.dev/stripe-cli-debian-local stable main" \
      | tee /etc/apt/sources.list.d/stripe.list > /dev/null \
    && apt-get update && apt-get install -y stripe \
    && rm -rf /var/lib/apt/lists/*

# Claude Code
RUN curl -fsSL https://claude.ai/install.sh | bash

# Pre-create config dirs
RUN mkdir -p /root/.config/gh \
             /root/.config/stripe \
             /root/.wrangler/config \
             /root/.gitconfig.d \
             /root/.claude \
             /root/.npm

EXPOSE 3000
EXPOSE 4242

ENTRYPOINT ["/sandbox"]
