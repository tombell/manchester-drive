"""Export the in-game driving network, retaining OSM node identity at junctions."""
import gzip
import json
from pathlib import Path

import osmium
from shapely.geometry import LineString, Polygon
from shapely.prepared import prep

from map_geometry import CAR_ROADS, road, xy


def write_routing(source, boundary, destination):
    region = prep(Polygon(boundary))
    left, top, right, bottom = region.context.bounds
    indices, nodes, ways = {}, [], []

    def node_index(ref, point):
        if ref not in indices:
            indices[ref] = len(nodes)
            nodes.append(point)
        return indices[ref]

    streets = osmium.FileProcessor(source).with_locations().with_filter(osmium.filter.EntityFilter(osmium.osm.WAY))
    for way in streets:
        tags = way.tags
        if (tags.get("highway") not in CAR_ROADS or tags.get("area") == "yes"
                or tags.get("indoor") == "yes" or len(way.nodes) < 2):
            continue
        props = road(way.id, dict(tags), [])
        if props["access"] not in {"yes", "permissive", "designated"}:
            continue
        points = [xy(n.lon, n.lat) for n in way.nodes]
        if not any(left <= x <= right and top <= y <= bottom for x, y in points):
            continue
        line = LineString(points)
        if not region.intersects(line):
            continue
        whole = region.covers(line)
        run = None
        for i in range(1, len(points)):
            if not whole and not region.covers(LineString(points[i-1:i+1])):
                run = None
                continue
            if run is None:
                run = [node_index(way.nodes[i-1].ref, points[i-1])]
                ways.append([props["name"], props["oneway"], run])
            run.append(node_index(way.nodes[i].ref, points[i]))

    data = json.dumps({"nodes": nodes, "ways": ways}, separators=(",", ":"), ensure_ascii=False)
    destination.write_bytes(gzip.compress(data.encode(), mtime=0))


if __name__ == "__main__":
    import sys
    directory = Path(__file__).resolve().parents[1] / "src/game/map"
    boundary = json.loads((directory / "region.json").read_text())["boundary"]
    write_routing(sys.argv[1], boundary, directory / "routing.pack")
