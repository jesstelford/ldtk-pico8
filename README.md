# LDtk PICO-8 tool

Export an [LDtk](https://ldtk.io) project to a PICO-8 cart.

## Why

- LDtk's [Auto Layer Rules](https://ldtk.io/docs/general/auto-layers/) enable
  "painting" map tiles
- Visual representation of sprite flags
- High fidelity editor lets you see the whole world at a glance

## Get Started

1. Open the [`pico8-project.ldtk`](pico8-project.ldtk) project file in LDtk,
   then Tilesets > Source Image > Select your sprite sheet.
2. Draw some tiles
3. Run `npx ldtk-pico8 pico8-project.ldtk --output=output.p8`
4. Run `output.p8` in PICO-8

## Usage

> **Warning**: Will overwrite `output.p8` if it exists.

```
Usage: npx ldtk-pico8 <LDtk project file> [options]

Options:
  -o, --output            Exported PICO-8 cart filename      [string] [required]
  -s, --overlap-strategy  How to handle overlapping sprite & map data
                          [choices: "error", "sprite", "map"] [default: "error"]
      --version           Show version number                          [boolean]
      --help              Show help                                    [boolean]
```

> **Note**: Requires `npx`, provided by [Node.js](https://nodejs.org/en/download)

`output.p8` will include your exported map and sprite data, plus basic code for
viewing the rendered map with arrow keys.

## LDtk Project Setup

### The easy way

1. Download [`pico8-project.ldtk`](pico8-project.ldtk)
1. Open it in LDtk
1. Go to Tilesets > Source Image > Select your sprite sheet (up to 128x128px)
1. Draw some tiles.

### Manual setup

LDtk is much more flexible than PICO-8, so there is some specific limitations /
setup that must be done for this tool to work correctly:

1. Create a single level representing the entire PICO-8 map (up to 1024px by
   512px)
1. (Optional) Create a single Enum to represent PICO-8 sprite flags (up to 8
   values.)
   - To match PICO-8, use this order of colors: red, orange, yellow, green,
     blue, purple, pink, peach.
1. Create a single tileset representing the entire PICO-8 sprite set (up to
   128px by 128px)
   - Set the "Tiles layout" to "8px"
   - If you created an Enum, set it as "Enum for tile marking"
   - To support rendering black within PICO-8, see [Transparency](#transparency)
     below.
1. Create as many "Tile", "IntGrid", or "Entities" layers as you like, ensuring:
   - "Tileset" points to the single tileset representing the PICO-8 sprite set
   - "Grid size" is set to "8px"
   - "Offsets" and "Parallax" are set to "0px"
1. Create as many "Entities" as you like, ensuring:
   - "Size" is a multiple of 8
   - "Editor visual" is set to the tileset you created

### Transparency

By default, PICO-8 treats color `0` as transparent which you may wish to change
using the `palt()` command. This is common when your art style uses "black
outline".

Instead of using a non-black color in your tileset, it can be useful to use real
transparency (eg in a `.png` file), then have this exporter convert transparent
pixels to the correct color.

To set which color is used as transparency when exporting, create a Level Custom
Field named `pico8_palt` with a value representing a PICO-8 color number.

## Shared Map & Sprite data

PICO-8 shares the bottom half of the sprite set with the bottom half of the map.
Since LDtk has no such limitations, it's possible to accidentally use a sprite
which would overwrite some map data or vice-versa.

In some cases, you may need more sprites with less map, so you use the shared
area for sprite data. And in other cases, you need more map than sprites, so you
use the shared area for map data.

The `--overlap-strategy` switch allows you to specify which strategy you wish to
use:

- `--overlap-strategy=error` (the default) will throw an error and stop
  processing if overlapping data is found.
- `--overlap-strategy=map` will overwrite any sprite data in the shared area
  with map data.
- `--overlap-strategy=sprite` will overwrite any map data in the shared area
  with sprite data.

It's possible to use the shared area for _both_ map and sprite data by being
careful with how you lay out your sprite image and/or your LDtk level data so
they don't conflict. Try playing around with leaving empty spaces in the
sprite/map to accomodate your usage.
