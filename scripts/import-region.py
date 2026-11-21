"""Build independently gzip-compressed map chunks from a Geofabrik Greater Manchester PBF."""
import gzip
import hashlib
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

import osmium
from shapely import make_valid
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import nearest_points, polygonize, unary_union
from shapely.prepared import prep

from map_overview import write_overview
from map_water import exposed_water, parts
from map_geometry import CAR_ROADS, PATHS, HEIGHT, WIDTH, SCALE, mapped_path, road, xy

CHUNK = 1440
# Include geometry across seams for road casings, labels, crowns and vehicle collisions.
MARGIN = 128
DEST = Path(__file__).resolve().parents[1] / "src" / "game" / "map"


def points(nodes):
    return [xy(n.lon, n.lat) for n in nodes]


def motorway_edge(source):
    motorways, ramps = [], []
    ways = osmium.FileProcessor(source).with_locations().with_filter(osmium.filter.EntityFilter(osmium.osm.WAY))
    for w in ways:
        h = w.tags.get("highway")
        if h == "motorway" and w.tags.get("ref") == "M60":
            motorways.append(LineString(points(w.nodes)))
        elif h in ("motorway_link", "trunk_link"):
            ramps.append(LineString(points(w.nodes)))
    # The mainline changes onto slip roads at interchanges. Polygonise that network
    # and select the face enclosing Piccadilly, then include BOTH carriageways.
    faces = polygonize(unary_union(motorways + ramps))
    centre = Point(xy(-2.237, 53.481))
    inner, = [p for p in faces if p.contains(centre)]
    shoulder = unary_union([Polygon(inner.exterior).buffer(60*SCALE)] +
                           [way.buffer(40*SCALE) for way in motorways])
    # A signed mainline stub at Simister sits beyond the orbital slip roads.
    # Keep its motorway shoulder connected to the rest of the playable area.
    while shoulder.geom_type == "MultiPolygon":
        main = max(shoulder.geoms, key=lambda p: p.area)
        detached = min((p for p in shoulder.geoms if p != main), key=main.distance)
        if main.distance(detached) > 400*SCALE:
            raise ValueError("Unexpected detached M60 carriageway")
        shoulder = shoulder.union(LineString(nearest_points(main, detached)).buffer(40*SCALE))
    edge = Polygon(shoulder.exterior).simplify(2*SCALE)
    if not 150 < edge.area / (1000*SCALE)**2 < 300 or not all(edge.contains(w) for w in motorways):
        raise ValueError("Review the mapped M60 junctions before updating the playable edge")
    return edge


def area_kind(t):
    if t.get("building") not in (None, "no", "roof"):
        return "building"
    if t.get("natural") == "water" or t.get("waterway") == "riverbank" or t.get("amenity") == "fountain":
        return "water"
    if t.get("name") == "Piccadilly Gardens" and t.get("leisure") in ("park", "garden"):
        return "gardens"
    if (t.get("landuse") in ("forest", "grass", "meadow", "recreation_ground", "allotments")
            or t.get("natural") in ("wood", "grassland", "scrub", "heath")
            or t.get("leisure") in ("park", "garden", "golf_course", "pitch", "common")):
        return "green"
    if t.get("highway") in PATHS and t.get("area") == "yes":
        return "plaza"


def as_points(coords):
    return [[round(x), round(y)] for x, y in coords]


def encoded(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()


def build(source):
    edge = motorway_edge(source)
    region = prep(edge.buffer(MARGIN))
    tiles = {}
    x0, y0, x1, y1 = map(int, edge.bounds)
    for i in range(x0//CHUNK-1, x1//CHUNK+2):
        for j in range(y0//CHUNK-1, y1//CHUNK+2):
            if 0 <= i and (i+1)*CHUNK <= WIDTH and 0 <= j and (j+1)*CHUNK <= HEIGHT:
                continue  # The bundled race district supplies these complete chunks.
            clip = box(i*CHUNK-MARGIN, j*CHUNK-MARGIN, (i+1)*CHUNK+MARGIN, (j+1)*CHUNK+MARGIN)
            if region.intersects(clip):
                tiles[i, j] = clip
    chunks = defaultdict(lambda: defaultdict(list))
    counts = Counter()

    def distribute(geom, key, props):
        x0, y0, x1, y1 = map(int, geom.bounds)
        fmt = geom.geom_type
        added = False
        if not geom.is_valid:
            geom = make_valid(geom)
        for i in range((x0-MARGIN)//CHUNK, (x1+MARGIN)//CHUNK+1):
            for j in range((y0-MARGIN)//CHUNK, (y1+MARGIN)//CHUNK+1):
                clip = tiles.get((i, j))
                if clip is None or not clip.intersects(geom):
                    continue
                pieces = [geom] if clip.covers(geom) and geom.geom_type == fmt else parts(geom.intersection(clip), fmt)
                for piece in pieces:
                    obj = props.copy()
                    if fmt == "Polygon":
                        rings = [as_points(r.coords[:-1]) for r in [piece.exterior, *piece.interiors]]
                        if key == "buildings":
                            obj["rings"] = rings
                        else:
                            obj["points"] = rings[0]
                            if len(rings) > 1:
                                obj["holes"] = rings[1:]
                    elif fmt == "Point":
                        obj = as_points(piece.coords)[0]
                    else:
                        obj["points"] = as_points(piece.coords)
                    chunks[i, j][key].append(obj)
                    added = True
        if added:
            counts[key] += 1

    features = osmium.FileProcessor(source).with_areas()
    for f in features:
        t = f.tags
        if f.is_node():
            if t.get("natural") == "tree":
                x, y = xy(f.lon, f.lat)
                if (x//CHUNK, y//CHUNK) in tiles and not (0 <= x <= WIDTH and 0 <= y <= HEIGHT):
                    distribute(Point(x, y), "trees", {})
        elif f.is_way():
            h = t.get("highway")
            tram = t.get("railway") == "tram"
            if (h not in CAR_ROADS and h not in PATHS and not tram) or t.get("area") == "yes" or t.get("indoor") == "yes":
                continue
            if len(f.nodes) < 2:
                continue
            geom = LineString(points(f.nodes))
            if h in CAR_ROADS:
                props = road(f.id, dict(t), [])
                distribute(geom, "roads", props)
            elif not t.get("layer", "").startswith("-"):
                distribute(geom, "paths", mapped_path(t, []))
        elif f.is_area():
            kind = area_kind(t)
            if not kind or t.get("location") == "underground" or t.get("layer", "").startswith("-"):
                continue
            for outer in f.outer_rings():
                geom = Polygon(points(outer), [points(h) for h in f.inner_rings(outer)])
                if kind == "building":
                    distribute(geom, "buildings", {"name": t.get("name", "")})
                else:
                    distribute(geom, "areas", {"kind": kind})

    DEST.mkdir(exist_ok=True)
    index = {}
    with (DEST / "region.pack").open("wb") as pack:
        for (i, j), layers in sorted(chunks.items()):
            if "areas" in layers:
                layers["areas"] = exposed_water(layers["areas"], layers.get("roads", []))
            chunk = gzip.compress(encoded(layers), compresslevel=9, mtime=0)
            index[f"{i},{j}"] = [pack.tell(), len(chunk)]
            pack.write(chunk)
    data = (DEST / "region.pack").read_bytes()
    (DEST / "index.json").write_bytes(encoded(index))
    boundary = as_points(edge.exterior.coords[:-1])
    (DEST / "region.json").write_bytes(encoded(dict(chunkSize=CHUNK, boundary=boundary,
        version=hashlib.sha256(data).hexdigest()[:16])))
    write_overview(source, Polygon(boundary), DEST / "overview.svg")
    print(counts, f"{len(index)} chunks, {len(data):,} bytes, {edge.area/(SCALE*1000)**2:.1f} km²")


if __name__ == "__main__":
    build(sys.argv[1])
