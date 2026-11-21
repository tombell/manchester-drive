"""Generate the north-up world map using the same projection as the driving map."""
from collections import defaultdict

import osmium
from shapely.geometry import LineString, Point

from map_geometry import SCALE, xy
from map_water import parts


def path(coords):
    return "M" + " ".join(f"{round(x)},{round(y)}" for x, y in coords)


def write_overview(source, edge, target):
    layers = defaultdict(list)
    places = {"Piccadilly Gardens": xy(-2.2371, 53.4811)}
    names = {"Prestwich", "Failsworth", "Didsbury", "Stretford", "Eccles", "Salford"}
    features = osmium.FileProcessor(source).with_locations().with_filter(
        osmium.filter.KeyFilter("highway", "waterway", "place"))
    for f in features:
        tags = f.tags
        if f.is_node() and tags.get("place") and tags.get("name") in names:
            position = xy(f.lon, f.lat)
            if edge.covers(Point(position)):
                places[tags["name"]] = position
        if not f.is_way() or len(f.nodes) < 2:
            continue
        kind = tags.get("highway")
        if tags.get("waterway") in ("river", "canal"):
            kind = "water"
        elif kind not in ("motorway", "trunk", "primary"):
            continue
        line = LineString([xy(n.lon, n.lat) for n in f.nodes])
        for piece in parts(edge.intersection(line), "LineString"):
            layers[kind].append(path(piece.simplify(8 * SCALE).coords))

    left, top, right, bottom = map(round, edge.bounds)
    svg = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{left} {top} {right-left} {bottom-top}">',
           '<title>Greater Manchester inside the M60</title>',
           '<g id="terrain">',
           f'<path fill="#39463e" d="{path(edge.exterior.coords)}Z"/>']
    for layer, ink, width in [("water", "#6498a2", 1.8), ("primary", "#788075", 1),
                              ("trunk", "#a19f81", 1.4), ("motorway", "#e2bc74", 2)]:
        lines = "".join(layers[layer])
        svg.append(f'<path fill="none" stroke="{ink}" stroke-width="{width}" '
                   f'vector-effect="non-scaling-stroke" stroke-linecap="round" d="{lines}"/>')
    svg.extend(['</g>', '<g id="places" fill="#f3efdd" stroke="#334138" '
                'paint-order="stroke" font-family="sans-serif" font-weight="bold" '
                'text-anchor="middle">'])
    for name, (x, y) in sorted(places.items()):
        svg.append(f'<text x="{x}" y="{y}">{name}</text>')
    svg.extend(['</g>', '</svg>'])
    target.write_text("\n".join(svg) + "\n")
