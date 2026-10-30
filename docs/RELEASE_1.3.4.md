# CCDX 1.3.4

Baseline: 1.3.3. The compact Auto refresh button could place its label against the top border because its overlaid grid items stretched after vertical padding was removed. Its grid now centers both labels horizontally and vertically while retaining stable ON/OFF width, 32 px desktop height and 44 px coarse-pointer targets.

The browser replay now measures the actual visible text range, rather than only the outer button or stretched span, in both languages and both toggle states. Existing palettes, header anchors and narrow layouts remain covered. This patch changes no SSE, inference, routing, authentication, accounts, model plans or client configuration behavior.

Release checks retain local verification, Windows/macOS/native-client CI, real browser cases, isolated 1.3.3 upgrade, strict/offline platform installs and independent public package/download integrity gates. The active local service is not switched by publication.
