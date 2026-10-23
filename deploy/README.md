The Chromium seccomp profile is copied unmodified from Playwright:
https://github.com/microsoft/playwright/blob/main/utils/docker/seccomp_profile.json
Retrieved 2026-10-23. The file is distributed under Playwright's Apache-2.0 license.
It permits the namespace syscalls needed for Chromium sandbox in Docker.
Use a non-root container user, this profile, and normal container isolation.
Do not add `--privileged`, `--no-sandbox`, or expose Chrome's debugging socket.
The Render Blueprint has no setting to install this host-side policy; browser
launch must be accepted on the actual selected hosting platform.
