#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const jimp = require("jimp");
const colorDiff = require("color-diff");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

const PICO_MAP_WIDTH_CELLS = 128;
const PICO_MAP_HEIGHT_CELLS = 64;

const PICO_MAP_WIDTH_PX = PICO_MAP_WIDTH_CELLS * 8;
const PICO_MAP_HEIGHT_PX = PICO_MAP_HEIGHT_CELLS * 8;

const PICO_MAP_DATA_NIBBLES = 2;

// Map shares rows 32 onward with gfx sprite data
const PICO_MAP_SHARED_ROWS_FROM = 32;

const PICO_SPRITE_WIDTH_CELLS = 16;
const PICO_SPRITE_HEIGHT_CELLS = 16;

const PICO_SPRITE_WIDTH_PX = PICO_SPRITE_WIDTH_CELLS * 8;
const PICO_SPRITE_HEIGHT_PX = PICO_SPRITE_HEIGHT_CELLS * 8;

const PICO_SPRITE_DATA_NIBBLES = 1;

// Sprite shares rows 64 onward with gfx sprite data
const PICO_SPRITE_SHARED_ROWS_FROM = 64;

// Sprite flags are stored in 2 rows of 128 flags (2 bytes each, so 256 chars
// per row).
const PICO_FLAGS_WIDTH = 128;
const PICO_FLAGS_DATA_NIBBLES = 2;

const LDTK_PALT_FIELD = "pico8_palt";

const PALETTE = [
  [0, 0, 0], // black
  [29, 43, 83], // dark-blue
  [126, 37, 83], // dark-purple
  [0, 135, 81], // dark-green
  [171, 82, 54], // brown
  [95, 87, 79], // dark-grey
  [194, 195, 199], // light-grey
  [255, 241, 232], // white
  [255, 0, 77], // red
  [255, 163, 0], // orange
  [255, 236, 39], // yellow
  [0, 228, 54], // green
  [41, 173, 255], // blue
  [131, 118, 156], // lavender
  [255, 119, 168], // pink
  [255, 204, 170], // light-peach
  // Mapped into an object ready for color diffing
].map(([R, G, B]) => ({ R, G, B }));

function defaultLayerFilter(layer) {
  console.warn(
    `[warn] Unexpected layer type "${layer.type}", skipping. [uid ${layer.uid}]`
  );
  return false;
}

function defaultLayerProcessor(layer) {
  console.warn(
    `[warn] Unexpected layer type "${layer.type}", skipping. [uid ${layer.uid}]`
  );
}

function toHex(x, ndigits) {
  return (x + (1 << (ndigits * 4))).toString(16).slice(-ndigits);
}

function arrayToHexString(arr, ndigits, defaultVal) {
  let outData = "";
  // NOTE: Can't use `.map()` here since it may be a sparse array, and .map
  // can't handle that.
  for (let i = 0; i < arr.length; ++i) {
    outData += toHex(Math.max(arr[i] ?? defaultVal, 0), ndigits);
  }
  return outData;
}

async function imageToIndexedPico8(img, palt, clipRect) {
  const image = await jimp.read(img);

  const { x1, y1, x2, y2, width, height } = intersectRects(clipRect, {
    x: 0,
    y: 0,
    width: image.bitmap.width,
    height: image.bitmap.height,
  });

  if (width !== image.bitmap.width || height !== image.bitmap.height) {
    console.warn(
      `[warn] Tileset image (${image.bitmap.width}x${image.bitmap.height}) will be clipped to (${width}x${height}).`
    );
  }

  let gfxOut = [];

  // Build up an array of pizel values. This may be a sparse array if the
  // tileset image size is thinner than the PICO-8 sprite area.
  image.scan(x1, y1, x2, y2, function (x, y, idx) {
    let paletteNumber;
    // Fully transparent pixel
    if (this.bitmap.data[idx + 3] === 0) {
      paletteNumber = palt;
    } else {
      // Use a perceptual diff to attempt color-matching to the PICO-8 palette
      const closest = colorDiff.closest(
        {
          R: this.bitmap.data[idx + 0], // red
          G: this.bitmap.data[idx + 1], // green
          B: this.bitmap.data[idx + 2], // blue
        },
        PALETTE
      );

      paletteNumber = PALETTE.findIndex(
        ({ R, G, B }) => closest.R === R && closest.B === B && closest.G === G
      );

      if (paletteNumber < 0) {
        console.warn(
          `[warn] Found non PICO-8 color ${cssHex} at ${x},${y}. Defaulting it to color 0.`
        );

        paletteNumber = 0;
      }
    }

    gfxOut[(y - y1) * width + (x - x1)] = paletteNumber;
  });

  return gfxOut;
}

function splitPICODataIntoLines(data, width, nibbles) {
  const charsPerLine = width * nibbles;
  const dataLines = data.match(new RegExp(`.{${charsPerLine}}`, "g"));

  // There may be a partial line of data, so we have to pad that out with "0"s
  const leftoverNibbles = data.length % charsPerLine;

  if (leftoverNibbles !== 0) {
    // Add the lefover line of data
    dataLines.push(
      data
        .slice(-leftoverNibbles)
        // Ensure it's a complete line
        .padEnd(charsPerLine, "0")
    );
  }

  return dataLines;
}

function joinGfxDataFromLines(gfxData) {
  return gfxData.join("");
}

function splitMapDataIntoLines(mapData) {
  const mapDataLines = mapData.match(
    new RegExp(`.{${PICO_MAP_WIDTH_CELLS * PICO_MAP_DATA_NIBBLES}}`, "g")
  );

  // There may be a partial line of data, so we have to pad that out with "0"s
  const leftoverNibbles =
    mapData.length % (PICO_MAP_WIDTH_CELLS * PICO_MAP_DATA_NIBBLES);

  if (leftoverNibbles !== 0) {
    // Add the lefover line of data
    mapDataLines.push(
      mapData
        .slice(-leftoverNibbles)
        // Ensure it's a complete line
        .padEnd(PICO_MAP_WIDTH_CELLS * PICO_MAP_DATA_NIBBLES, "0")
    );
  }

  return mapDataLines;
}

function joinMapDataFromLines(mapData) {
  return mapData.join("");
}

// Clip data to maximum allowed by PICO-8
function clipGfxData(gfxData) {
  return gfxData.slice(
    0,
    PICO_SPRITE_WIDTH_PX * PICO_SPRITE_HEIGHT_PX * PICO_SPRITE_DATA_NIBBLES
  );
}

// Trim trailing lines of all 0's, since PICO-8 will default them to "0" and
// will not normally output them in a .p8 cart.
// See: https://pico-8.fandom.com/wiki/P8FileFormat
function trimGfxData(gfxData) {
  return gfxData.replace(
    new RegExp(`(0{${PICO_SPRITE_WIDTH_PX * PICO_SPRITE_DATA_NIBBLES}})+$`),
    ""
  );
}

function trimGfxDataLines(gfxDataLines) {
  return splitPICODataIntoLines(
    trimGfxData(joinGfxDataFromLines(gfxDataLines)),
    PICO_SPRITE_WIDTH_PX,
    PICO_SPRITE_DATA_NIBBLES
  );
}

function trimMapDataLines(mapDataLines) {
  return splitPICODataIntoLines(
    trimMapData(joinMapDataFromLines(mapDataLines)),
    PICO_MAP_WIDTH_CELLS,
    PICO_MAP_DATA_NIBBLES
  );
}

// Trim trailing lines of all 0's, since PICO-8 will default them to "0" and
// will not normally output them in a .p8 cart.
// See: https://pico-8.fandom.com/wiki/P8FileFormat
function trimMapData(mapData) {
  return mapData.replace(
    new RegExp(`(0{${PICO_MAP_WIDTH_CELLS * PICO_MAP_DATA_NIBBLES}})+$`),
    ""
  );
}

// Any overlapping map area will be merged into the sprite data, then removed
// from the map data
// At this point we may have overlapping sprite and map data; The bottom 64
// rows of pixels in the sprite sheet (gfx) is shared with the bottom 32 rows
// of cells in the map.
// We have 3 strategies for dealing with this:
// 0. If there's no overlap, there's no problem!
// 1. "error" strategy: Throw an error if there's overlapping data
// 2. "map" strategy: Overwrite sprite data with map data
// 3. "sprite" strategy: Overwrite map data with sprite data
function mergeP8SharedMapIntoSpriteData(gfxDataLines, mapDataLines, strategy) {
  if (
    mapDataLines.length > PICO_MAP_SHARED_ROWS_FROM &&
    gfxDataLines.length > PICO_SPRITE_SHARED_ROWS_FROM &&
    overlapStrategy === "error"
  ) {
    throw new Error(
      `Overlap strategy "error" prevents merging shared map & sprite data: Sprite data uses ${
        gfxDataLines.length - PICO_SPRITE_SHARED_ROWS_FROM
      } rows of shared pixel space, and Map data uses ${
        mapDataLines.length - PICO_MAP_SHARED_ROWS_FROM
      } rows of shared map space.`
    );
  }

  if (mapDataLines.length <= PICO_MAP_SHARED_ROWS_FROM) {
    // Nothing to merge
    return [gfxDataLines, mapDataLines];
  }

  // Make a copy to work on
  let gfxDataLinesOut = [...gfxDataLines];

  // pad out gfxData so it's large enough to append the map data
  for (let i = gfxDataLines.length; i < PICO_SPRITE_SHARED_ROWS_FROM; i++) {
    gfxDataLinesOut.push(
      "".padEnd(PICO_SPRITE_WIDTH_PX * PICO_SPRITE_DATA_NIBBLES, "0")
    );
  }

  const mapAsGfxData = mapDataLines
    .join("")
    // The byte order needs to be swapped for storage within the gfx data
    .replace(/(.)(.)/g, "$2$1");

  const mapAsGfxDataLines = splitPICODataIntoLines(
    mapAsGfxData,
    PICO_SPRITE_WIDTH_PX,
    PICO_SPRITE_DATA_NIBBLES
  );

  if (strategy === "map") {
    console.warn(
      '[info] Using "map" overlap strategy; map data will overwrite sprite data in the shared space.'
    );
    // We're only interested in the shared rows
    const mapAsGfxDataLinesToInsert = mapAsGfxDataLines.slice(
      PICO_SPRITE_SHARED_ROWS_FROM
    );

    // Map data wins, so just copy it straight over the sprite data
    gfxDataLinesOut.splice(
      PICO_SPRITE_SHARED_ROWS_FROM,
      mapAsGfxDataLinesToInsert.length,
      ...mapAsGfxDataLinesToInsert
    );
  } else if (strategy === "sprite") {
    console.warn(
      '[info] Using "sprite" overlap strategy; map data will overwrite sprite data in the shared space.'
    );
    // Sprite data wins, so only copy over map data that comes after the end of
    // the sprites
    gfxDataLinesOut = gfxDataLinesOut.concat(
      mapAsGfxDataLines.slice(gfxDataLinesOut.length)
    );
  } else {
    throw new Error(
      `Unknown sprite/map merge strategy "${strategy.toString()}"`
    );
  }

  // The remaining map data is everything before the shared area
  // Then trimmed to remove trailing 0s
  const mapDataLinesOut = trimMapDataLines(
    mapDataLines.slice(0, PICO_MAP_SHARED_ROWS_FROM)
  );

  gfxDataLinesOut = trimGfxDataLines(gfxDataLinesOut);

  return [gfxDataLinesOut, mapDataLinesOut];
}

async function convertLdtkTilesetToPico8Gfx(
  tileset,
  ldtkFilePath,
  palt,
  clipRect
) {
  let gfxData = "";
  if (tileset?.relPath) {
    gfxData = arrayToHexString(
      await imageToIndexedPico8(
        path.resolve(path.dirname(ldtkFilePath), tileset.relPath),
        palt,
        clipRect
      ),
      PICO_SPRITE_DATA_NIBBLES,
      0
    );
  }

  gfxData = clipGfxData(gfxData);
  gfxData = trimGfxData(gfxData);

  // Split the data up into individual lines ready for counting and merging
  return splitPICODataIntoLines(
    gfxData,
    PICO_SPRITE_WIDTH_PX,
    PICO_SPRITE_DATA_NIBBLES
  );
}

function writeP8Cart({ __gfx__, __gff__, __map__, __lua__ }) {
  const prefix = `pico-8 cartridge // http://www.pico-8.com
version 41`;

  return [prefix]
    .concat(__lua__?.length ? ["__lua__", ...__lua__] : [])
    .concat(__gfx__?.length ? ["__gfx__", ...__gfx__] : [])
    .concat(__gff__?.length ? ["__gff__", ...__gff__] : [])
    .concat(__map__?.length ? ["__map__", ...__map__] : [])
    .join("\n");
}

function loadLdtkProject(ldtkFile) {
  let ldtkData;
  let ldtk;

  // Attempt to load the file
  try {
    ldtkData = fs.readFileSync(ldtkFile);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Cannot load file ${ldtkFile}`);
    } else {
      throw error;
    }
  }

  // Parse out the JSON
  try {
    ldtk = JSON.parse(ldtkData.toString());
  } catch (error) {
    throw new Error(`File is not valid JSON: ${ldtkFile}`);
  }

  return ldtk;
}

function extractLdtkLevel(ldtk) {
  if (ldtk.levels.length > 0) {
    console.warn(
      "[warn] Detected more than one level. Only the first level will be processed."
    );
  }

  const level = ldtk.levels[0];

  if (
    level.pxWid > PICO_MAP_WIDTH_CELLS * 8 ||
    level.pxHei > PICO_MAP_HEIGHT_CELLS * 8
  ) {
    console.warn(
      `[warn] Level (${Math.ceil(level.pxWid / 8)}x${Math.ceil(
        level.pxHei / 8
      )}) will be clipped to the PICO-8 map (${PICO_MAP_WIDTH_CELLS}x${PICO_MAP_HEIGHT_CELLS}).`
    );
  }

  return level;
}

const layerFilters = {
  Tiles: (layer) => layer.gridTiles.length > 0,
  IntGrid: (layer) => layer.autoLayerTiles.length > 0,
  Entities: (layer) => layer.entityInstances.length > 0,
};

function extractLtdkTileset(ldtkLevel, ldtk) {
  let tileset;

  function setTileset(tilesetUid) {
    if (tilesetUid == null) {
      return;
    }

    if (tileset) {
      if (tileset.uid === tilesetUid) {
        // Nothing to do, this tileset is already loaded
        return;
      }

      // Can only have a single tileset in use!
      throw new Error(
        "Cannot use multiple tilesets. Use a single tileset (representing the entire PICO-8 sprite sheet) for all layers and entities."
      );
    }

    tileset = ldtk.defs.tilesets.find(({ uid }) => uid === tilesetUid);

    if (tileset.tileGridSize !== 8) {
      throw new Error(
        "Tileset must have an 8px grid size for compatibility with PICO-8"
      );
    }
  }

  ldtkLevel.layerInstances
    .filter((layer) => layer.visible)
    .filter((layer) => {
      return (layerFilters[layer.__type] ?? defaultLayerFilter)(layer);
    })
    .forEach((layer) => {
      if (layer.__type === "Tiles" || layer.__type === "IntGrid") {
        setTileset(layer.__tilesetDefUid);
      } else if (layer.__type == "Entities") {
        layer.entityInstances
          .filter(({ __tile }) => !!__tile)
          .forEach((entity) => {
            setTileset(entity.__tile.tilesetUid);
          });
      } else {
        defaultLayerProcessor(layer);
      }
    });

  return tileset;
}

function extractLdtkFlatTiles(ldtkLevel, mapClipRect, spriteClipRect) {
  let map = [];
  let spriteOutOfBounds = false;
  let mapOutOfBounds = false;

  function coordToIndex(x, y, width, scale) {
    // Note: This is flexible and allows the pixels to be anywhere within a tile
    // rather than only the top-left pixel exactly.
    return Math.floor(y / scale) * width + Math.floor(x / scale);
  }

  function setMapValue(mapX, mapY, spriteX, spriteY) {
    // If it's out of bounds, we just skip it
    if (
      mapX < mapClipRect.x ||
      mapX >= mapClipRect.x + mapClipRect.width ||
      mapY < mapClipRect.y ||
      mapY >= mapClipRect.y + mapClipRect.height
    ) {
      mapOutOfBounds = true;
      return;
    }
    if (
      spriteX < spriteClipRect.x ||
      spriteX >= spriteClipRect.x + spriteClipRect.width ||
      spriteY < spriteClipRect.y ||
      spriteY >= spriteClipRect.y + spriteClipRect.height
    ) {
      spriteOutOfBounds = true;
      return;
    }

    const spriteIndex = coordToIndex(
      spriteX,
      spriteY,
      PICO_SPRITE_WIDTH_CELLS,
      8
    );
    map[coordToIndex(mapX, mapY, PICO_MAP_WIDTH_CELLS, 8)] = spriteIndex;

    return true;
  }

  ldtkLevel.layerInstances
    .filter((layer) => layer.visible)
    .filter((layer) => {
      return (layerFilters[layer.__type] ?? defaultLayerFilter)(layer);
    })
    // LDtk orders layers visually (top one wins), but we want to process them
    // logically (last one wins), so we reverse them.
    .reverse()
    .forEach((layer) => {
      if (layer.__type === "Tiles" || layer.__type === "IntGrid") {
        (layer.autoLayerTiles ?? layer.gridTiles ?? []).forEach((gridTile) => {
          if (gridTile.f !== 0) {
            throw new Error(
              `Cannot process flipped tiles in layer "${layer.__identifier}". Ensure there are no rules with flipping enabled.`
            );
          }

          // Set the map value based on the tile this entity references
          setMapValue(
            gridTile.px[0],
            gridTile.px[1],
            gridTile.src[0],
            gridTile.src[1]
          );
        });
      } else if (layer.__type === "Entities") {
        layer.entityInstances
          .filter(({ __tile }) => !!__tile)
          .forEach((entity) => {
            // Set the map value based on the tile this entity references
            setMapValue(
              entity.px[0],
              entity.px[1],
              entity.__tile.x,
              entity.__tile.y
            );
          });
      } else {
        defaultLayerProcessor(layer);
      }
    });

  if (mapOutOfBounds) {
    console.warn(
      `[warn] Layer will be clipped to (${mapClipRect.width}x${mapClipRect.height}).`
    );
  }

  if (spriteOutOfBounds) {
    console.warn(
      `[warn] Layer tile sits outside PICO-8 sprite area (${spriteClipRect.width}x${spriteClipRect.height}).`
    );
  }

  return map;
}

function extractLtdkPalTField(ldtkLevel) {
  return ldtkLevel.fieldInstances.find(
    ({ __identifier, __type }) =>
      __identifier === LDTK_PALT_FIELD && __type == "Int"
  )?.__value;
}

function convertLdtkFlatTilesToP8MapData(ldtkFlatTiles) {
  // The cell numbers referenced are based on the LDtk tileset, not the PICO-8
  // sprite, which could be different sizes, so we remap the tilenumbers
  let mapData = arrayToHexString(ldtkFlatTiles, PICO_MAP_DATA_NIBBLES, 0);
  mapData = trimMapData(mapData);
  return splitPICODataIntoLines(
    mapData,
    PICO_MAP_WIDTH_CELLS,
    PICO_MAP_DATA_NIBBLES
  );
}

// r1 = { x, y, width, height }
// r2 = { x, y, width, height }
// If any are not specified, it means "Use the other rect's value"
// return { x1, y1, x2, y2, width, height }
function intersectRects(
  {
    x: r1x = -Infinity,
    y: r1y = -Infinity,
    width: r1width = Infinity,
    height: r1height = Infinity,
  } = {},
  {
    x: r2x = -Infinity,
    y: r2y = -Infinity,
    width: r2width = Infinity,
    height: r2height = Infinity,
  } = {}
) {
  if (r1width === Infinity && r2width === Infinity) {
    throw new Error("At least one rect must specify a width");
  }
  if (r1height === Infinity && r2height === Infinity) {
    throw new Error("At least one rect must specify a height");
  }
  if (r1x === -Infinity && r2x === -Infinity) {
    throw new Error("At least one rect must specify an x value");
  }
  if (r1y === -Infinity && r2y === -Infinity) {
    throw new Error("At least one rect must specify an y value");
  }

  x1 = Math.max(r1x, r2x);
  y1 = Math.max(r1y, r2y);

  x2 = Math.min(r1x + r1width, r2x + r2width);
  y2 = Math.min(r1y + r1height, r2y + r2height);

  return { x1, y1, x2, y2, width: x2 - x1, height: y2 - x1 };
}

/*
 Take something like:
  enumTags: [
    { enumValueId: "Ground", tileIds: [1, 2] }, // index "0"
    { enumValueId: "Spikes", tileIds: [] }, // index "1"
    { enumValueId: "Grass", tileIds: [2, 4] }, // index "2"
    { enumValueId: "Player", tileIds: [5] }, // index "3"
  ],

  and convert it into:
 
  [[], [0], [0, 2], [], [2], [3]]
*/
function extractLtdkTilesetEnum(ldtkTileset, clipRect) {
  const levelWidth = ldtkTileset.__cWid;
  const levelHeight = ldtkTileset.__cHei;
  const enums = [];

  const { x1, y1, x2, y2, width, height } = intersectRects(clipRect, {
    x: 0,
    y: 0,
    width: levelWidth,
    height: levelHeight,
  });

  if ((ldtkTileset.enumTags ?? []).length > 8) {
    console.warn(
      `[warn] Skipping tileset Enums after the first 8; PICO-8 can only have up to 8 sprite flags. [uid ${ldtkTileset.uid}]`
    );
  }

  (ldtkTileset.enumTags ?? []).slice(0, 8).forEach((enumTag, index) => {
    // Tile IDs are 0-based
    (enumTag.tileIds ?? []).forEach((tileId) => {
      // Figure out the x/y based on the ID
      const tileX = tileId % levelWidth;
      const tileY = Math.floor(tileId / levelWidth);

      // Don't include tiles that are outside the specified area
      if (tileX < x2 && tileY < y2) {
        enumId = (tileY - y1) * width + (tileX - x1);
        enums[enumId] = enums[enumId] || [];
        enums[enumId].push(index);
      }
    });
  });

  // May have created a sparse array, so fill in the blanks
  for (let i = 0; i < width * height; i++) {
    enums[i] = enums[i] ?? [];
  }

  return enums;
}

function convertLdtkTilesetEnumToP8SpriteFlags(ldtkTilesetEnum) {
  const flagsArray = ldtkTilesetEnum.map((indexes) => {
    return indexes.reduce((value, index) => {
      return value | (1 << index);
    }, 0);
  });
  const flagData = arrayToHexString(flagsArray, PICO_FLAGS_DATA_NIBBLES, 0);
  return splitPICODataIntoLines(
    flagData,
    PICO_FLAGS_WIDTH,
    PICO_FLAGS_DATA_NIBBLES
  );
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .usage("Usage: $0 <LDtk project file> [options]")
    .demandCommand(1, "Must provide an LDtk project file")
    .option("o", {
      alias: "overlap-strategy",
      describe: "How to handle overlapping sprite & map data",
      choices: ["error", "sprite", "map"],
      default: "error",
    })
    .help().argv;

  const ldtkFilePath = path.resolve(process.cwd(), argv._[0]);
  const ldtk = loadLdtkProject(ldtkFilePath);
  const ldtkLevel = extractLdtkLevel(ldtk);
  const ldtkTileset = extractLtdkTileset(ldtkLevel, ldtk);
  const ldtkTilesetEnum = extractLtdkTilesetEnum(ldtkTileset, {
    x: 0,
    y: 0,
    width: PICO_SPRITE_WIDTH_CELLS,
    height: PICO_SPRITE_HEIGHT_CELLS,
  });
  const ldtkFlatTiles = extractLdtkFlatTiles(
    ldtkLevel,
    {
      x: 0,
      y: 0,
      width: PICO_MAP_WIDTH_PX,
      height: PICO_MAP_HEIGHT_PX,
    },
    {
      x: 0,
      y: 0,
      width: PICO_SPRITE_WIDTH_PX,
      height: PICO_SPRITE_HEIGHT_PX,
    }
  );
  const palt = extractLtdkPalTField(ldtkLevel) ?? 0;

  let p8spriteData = await convertLdtkTilesetToPico8Gfx(
    ldtkTileset,
    ldtkFilePath,
    palt,
    {
      x: 0,
      y: 0,
      width: PICO_SPRITE_WIDTH_PX,
      height: PICO_SPRITE_HEIGHT_PX,
    }
  );
  let p8spriteFlags = convertLdtkTilesetEnumToP8SpriteFlags(ldtkTilesetEnum);
  let p8mapData = convertLdtkFlatTilesToP8MapData(ldtkFlatTiles, ldtkTileset);
  [p8spriteData, p8mapData] = mergeP8SharedMapIntoSpriteData(
    p8spriteData,
    p8mapData,
    argv["overlap-strategy"]
  );

  const cart = writeP8Cart({
    __gfx__: p8spriteData,
    __gff__: p8spriteFlags,
    __map__: p8mapData,
    __lua__: `-- generated by ldtk-pico8
cx = 0
cy = 0

function _update()
 if (btn(0)) cx -= 2
 if (btn(1)) cx += 2
 if (btn(2)) cy -= 2
 if (btn(3)) cy += 2
end

function _draw()
 cls(${
   palt === 0
     ? `0)`
     : `${palt})
 palt(0,false)
 palt(${palt},true)`
 }
 camera(cx,cy)
 map(0,0,0,0,128,64)${
   palt === 0
     ? ``
     : `
 palt(0)`
 }
end`.split("\n"),
  });

  console.log(cart);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`[erro] ${error.messge || error.toString()}`);
    process.exit(-1);
  });
