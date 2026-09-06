# Benchmark photograph

`astronaut.jpg` is the 512 x 512 photograph of NASA astronaut Eileen Collins
distributed by scikit-image, converted from PNG to JPEG at quality 90 without
resizing. The original is credited to NASA and documented as public domain.

- [Original image](https://github.com/scikit-image/scikit-image/blob/v0.19.3/skimage/data/astronaut.png)
- [Source and public-domain statement](https://github.com/scikit-image/scikit-image/blob/v0.19.3/skimage/data/_fetchers.py#L405-L424)
- Original PNG SHA-256: `88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5`

The benchmark decodes this fixture to PNG before request preparation to exercise
real image encoding. Its 2560 x 1600 screenshot fixture is generated locally
from SVG. Neither fixture contains user data or requires a network request.
