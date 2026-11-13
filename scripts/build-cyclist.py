"""ライダーの GLB を作る（Blender 4.5 のバックグラウンド実行）。

    "C:/Program Files/Blender Foundation/Blender 4.5/blender.exe" --background --factory-startup --python scripts/build-cyclist.py

downhill-3D の scripts/build-cyclist.py（MakeHuman / MPFB2 の CC0 人体に服を着せる手順）を写して直した物。
変えた所:
- 体・服・靴・髪・眉・グラス・あごひもを1つの形状にまとめ、材質は1つ（cyclist_palette）にする。
  色は面ごとに「色の表の番号」(src/render/cyclist/palette.ts の SLOT) を UV の u に入れて渡す。
- 髪（頭皮から少し浮かせた殻）、眉、フレームとレンズのあるグラス、顔に沿うあごひも、靴底とダイヤルのある靴。
- ヘルメットは頭の表面へ光線を当てて形を決め（頭から浮かない）、通常とエアロの2形を別の形状として持つ。
  通気孔とジャージの柄は描画時に画素ごとに塗る（palette.ts）。
- 軽量画質用に三角形を減らした版（名前の末尾 _lod1）を同じ GLB に入れる。
座標: Blender は +X が左、-Y が前、+Z が上（three.js では (x, z, -y)）。
"""
import bpy, bmesh, json, pathlib, gzip, math, hashlib
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / 'assets-source/rider/makehuman-v1'
OUT = ROOT / 'public/assets/rider'
OUT.mkdir(parents=True, exist_ok=True)
WORK = ROOT / 'assets-source/rider/cyclist-v2'
WORK.mkdir(parents=True, exist_ok=True)

# palette.ts の SLOT と同じ番号
SLOT = dict(SOCK=14, ZIP=15, SKIN=16, HAIR=17, JERSEY=18, JERSEY_ACCENT=19, BIB=20, LEG=21, SHOE=22, SOLE=23, GLOVE=24,
            HELMET=25, HELMET_INNER=26, LENS=27, GLASSES_FRAME=28, STRAP=29, BIB_TRIM=30, SHOE_DIAL=31)

bpy.ops.wm.read_factory_settings(use_empty=True)
palette = bpy.data.materials.new('cyclist_palette')
palette.diffuse_color = (.8, .8, .8, 1)

# ---- 人体（MakeHuman の基本形に体型の差分を足す） ----
verts = []; uvs = []; faces = []; groups = {}; group = ''
for line in (SRC / 'base.obj').read_text().splitlines():
    p = line.split()
    if not p: continue
    if p[0] == 'v': verts.append(Vector(map(float, p[1:4])))
    elif p[0] == 'g': group = p[1]
    elif p[0] == 'f':
        f = [int(x.split('/')[0]) - 1 for x in p[1:]]
        groups.setdefault(group, set()).update(f)
        if group == 'body': faces.append(f)
for file, weight in [('asian-male-young.target.gz', 1), ('universal-male-young-averagemuscle-averageweight.target.gz', .65),
                     ('universal-male-young-maxmuscle-averageweight.target.gz', .35)]:
    for line in gzip.open(SRC / file, 'rt'):
        p = line.split()
        if len(p) == 4 and not p[0].startswith('#'):
            verts[int(p[0])] += Vector(map(float, p[1:])) * weight
# 元はデシメートル・Y が上・+Z が前。Blender では X, -Z, Y
bottom = min(verts[i].y for i in groups['body']); top = max(verts[i].y for i in groups['body'])
scale = 1.78 / (top - bottom)
coords = [Vector((p.x * scale, -p.z * scale, (p.y - bottom) * scale)) for p in verts]
used = sorted(groups['body']); remap = {old: i for i, old in enumerate(used)}
mesh = bpy.data.meshes.new('human_surface')
mesh.from_pydata([coords[i] for i in used], [], [[remap[i] for i in f] for f in faces]); mesh.update()
human = bpy.data.objects.new('cyclist_body', mesh); bpy.context.collection.objects.link(human)
mesh.materials.append(palette)
for poly in mesh.polygons: poly.use_smooth = True

rigdata = json.loads((SRC / 'rig.game_engine.json').read_text())
def point(data):
    if data['strategy'] == 'CUBE': ids = groups[data['cube_name']]
    elif data['strategy'] == 'MEAN': ids = data['vertex_indices']
    elif data['strategy'] == 'VERTEX': ids = [data['vertex_index']]
    else: raise ValueError(data)
    return sum((coords[i] for i in ids), Vector()) / len(ids)
arm = bpy.data.armatures.new('cyclist_skeleton'); rig = bpy.data.objects.new('cyclist_rig', arm); bpy.context.collection.objects.link(rig)
bpy.context.view_layer.objects.active = rig; rig.select_set(True); bpy.ops.object.mode_set(mode='EDIT')
for name, data in rigdata.items():
    b = arm.edit_bones.new(name); b.head = point(data['head']); b.tail = point(data['tail']); b.roll = data['roll']
for name, data in rigdata.items():
    if data['parent']: arm.edit_bones[name].parent = arm.edit_bones[data['parent']]
bpy.ops.object.mode_set(mode='OBJECT')
weights = json.loads((SRC / 'weights.game_engine.json').read_text())['weights']
for name, items in weights.items():
    vg = human.vertex_groups.new(name=name)
    for old, w in items:
        if old in remap: vg.add([remap[old]], w, 'REPLACE')
def skin_to_rig(obj):
    mod = obj.modifiers.new('skin', 'ARMATURE'); mod.object = rig; obj.parent = rig
skin_to_rig(human)

# ---- 服の境目に辺を入れる（境目が骨で動いても滑らか） ----
bm = bmesh.new(); bm.from_mesh(mesh)
cuffs = {}; wrists = {}
planes = [(Vector((0, 0, z)), Vector((0, 0, 1))) for z in [.60, .615, 1.07, 1.08, 1.525, 1.535]]
for suffix in ['l', 'r']:
    b = arm.bones['upperarm_' + suffix]; direction = (b.tail_local - b.head_local).normalized(); pt = b.head_local.lerp(b.tail_local, .72)
    cuffs[suffix] = (pt, direction); planes.extend([(pt, direction), (pt - direction * .014, direction)])
    b = arm.bones['lowerarm_' + suffix]; direction = (b.tail_local - b.head_local).normalized(); pt = b.tail_local - direction * .025
    wrists[suffix] = (pt, direction); planes.append((pt, direction))
for pt, direction in planes:
    bmesh.ops.bisect_plane(bm, geom=list(bm.verts) + list(bm.edges) + list(bm.faces), plane_co=pt, plane_no=direction, dist=.00001, clear_inner=False, clear_outer=False)
# 靴の中に隠れる足先は消す（足首を曲げた時に靴底から出ないように）
bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.calc_center_median().z < .10], context='FACES')
bm.to_mesh(mesh); bm.free(); mesh.update()

def body_slot(p):
    suffix = 'l' if p.x > 0 else 'r'
    cuff, armdir = cuffs[suffix]; wrist, foredir = wrists[suffix]
    if p.z < .60: return SLOT['LEG']
    if abs(p.x) > .29 and (p - wrist).dot(foredir) > 0: return SLOT['GLOVE']
    if abs(p.x) > .24:
        d = (p - cuff).dot(armdir)
        if d > 0: return SLOT['SKIN']
        if d > -.014 and p.z > 1.07: return SLOT['JERSEY_ACCENT']
    if p.z < .615: return SLOT['BIB_TRIM']
    if p.z < 1.07 and abs(p.x) < .29: return SLOT['BIB']
    if p.z < 1.535:
        return SLOT['JERSEY_ACCENT'] if (p.z < 1.08 or p.z > 1.525) else SLOT['JERSEY']
    return SLOT['SKIN']

def set_slots(obj, slot_of_face):
    """面ごとの番号を UV の u に入れる（UV は SLOT の1枚だけにする）"""
    me = obj.data
    for layer in list(me.uv_layers): me.uv_layers.remove(layer)
    uv = me.uv_layers.new(name='SLOT')
    for poly in me.polygons:
        s = slot_of_face(poly)
        for li in poly.loop_indices: uv.data[li].uv = (s, .5)
    if not me.materials: me.materials.append(palette)

def rigid(obj, bone):
    vg = obj.vertex_groups.new(name=bone); vg.add(list(range(len(obj.data.vertices))), 1, 'REPLACE')
    skin_to_rig(obj)

def link(name, vs, fs, slot_of_face, smooth=True, recalc=True):
    me = bpy.data.meshes.new(name); me.from_pydata(vs, [], fs); me.update()
    if recalc:
        bm = bmesh.new(); bm.from_mesh(me)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(me); bm.free(); me.update()
    me.materials.append(palette)
    for poly in me.polygons: poly.use_smooth = smooth
    o = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(o)
    set_slots(o, slot_of_face if callable(slot_of_face) else (lambda _p, s=slot_of_face: s))
    return o

def bvh_of(obj):
    me = obj.data
    return BVHTree.FromPolygons([v.co.copy() for v in me.vertices], [p.vertices[:] for p in me.polygons])

body_bvh = bvh_of(human)
headverts = [v.co for v in mesh.vertices if v.co.z > 1.58]
cy = (min(p.y for p in headverts) + max(p.y for p in headverts)) * .5
head_top = max(p.z for p in headverts)

def onto_skin(p, offset):
    """皮膚の最も近い点から外へ offset 浮かせた点"""
    loc, nor, _, _ = body_bvh.find_nearest(p)
    return loc + nor * offset

def ribbon(name, pts, width, thick, slot, offset, samples=4):
    """皮膚に沿う平たい帯（あごひも・テンプル）"""
    path = []
    for a, b in zip(pts, pts[1:]):
        for k in range(samples): path.append(a.lerp(b, k / samples))
    path.append(pts[-1])
    path = [onto_skin(p, offset(p) if callable(offset) else offset) for p in path]
    vs = []; fs = []
    for i, p in enumerate(path):
        t = (path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]).normalized()
        _, n, _, _ = body_bvh.find_nearest(p)
        side = t.cross(n).normalized()
        for s, h in [(-1, 0), (1, 0), (1, 1), (-1, 1)]:
            vs.append(p + side * s * width * .5 + n * (h * thick))
        if i:
            k = i * 4
            for j in range(4): fs.append((k - 4 + j, k - 4 + (j + 1) % 4, k + (j + 1) % 4, k + j))
    return link(name, vs, fs, slot, smooth=False)

def body_parts(lod):
    """体に付く小物（髪・眉・グラス・あごひも・靴）。lod=0 が詳しい版"""
    parts = []
    # 髪: 頭皮の面を写して外へ浮かせる
    hair = human.copy(); hair.data = human.data.copy(); hair.name = f'hair_{lod}'; bpy.context.collection.objects.link(hair)
    bm = bmesh.new(); bm.from_mesh(hair.data)
    def is_hair(p):
        # 殻は描画時に塗る生え際（palette.ts）より内側だけにする（縁の段差が同じ色に隠れる）
        yb = p.y - cy  # 正が後ろ
        if abs(p.x) > .062 and -.04 < yb < .04 and p.z < 1.715: return False  # 耳のまわり
        if p.z > 1.745: return True
        if yb > .045 and p.z > 1.63: return True
        if yb > -.02 and p.z > 1.69: return True
        return False
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if not is_hair(f.calc_center_median())], context='FACES')
    bm.normal_update()
    for v in bm.verts:
        v.co += v.normal * (.004 + .004 * max(0, min(1, (v.co.z - 1.6) / .15)))
    if lod:
        bmesh.ops.dissolve_limit(bm, angle_limit=.12, verts=bm.verts, edges=bm.edges)
    bm.to_mesh(hair.data); bm.free()
    set_slots(hair, lambda _p: SLOT['HAIR'])
    parts.append(hair)
    # 眉
    for side in [-1, 1]:
        pts = [Vector((side * x, cy - .3, z)) for x, z in [(.014, 1.701), (.028, 1.705), (.042, 1.704), (.054, 1.699)]]
        hits = []
        for p in pts:
            loc, _, _, _ = body_bvh.ray_cast(p, Vector((0, 1, 0)))
            if loc is None: raise ValueError('eyebrow ray missed')
            hits.append(loc)
        parts.append(ribbon(f'brow_{lod}', hits, .0045, .001, SLOT['HAIR'], .0011, samples=3 if lod == 0 else 1))
    # グラス: 目と こめかみの位置から、顔を包む2次曲面のレンズ
    def front_y(x, z):
        loc, _, _, _ = body_bvh.ray_cast(Vector((x, cy - .3, z)), Vector((0, 1, 0)))
        if loc is None: raise ValueError('glasses ray missed')
        return loc.y
    y1 = front_y(.032, 1.668) - .02; y2 = front_y(.068, 1.668) - .013
    b = (y2 - y1) / (.068 ** 2 - .032 ** 2); a = y1 - b * .032 ** 2
    nx = 16 if lod == 0 else 8; nz = 4 if lod == 0 else 2
    vs = []; fs = []
    for i in range(nx + 1):
        x = -.072 + .144 * i / nx
        zt = 1.694 - 1.1 * x * x
        zb = 1.641 + 1.4 * x * x + .013 * math.exp(-(x / .012) ** 2)
        for j in range(nz + 1):
            z = zb + (zt - zb) * j / nz
            vs.append(Vector((x, a + b * x * x, z)))
    for i in range(nx):
        for j in range(nz):
            k = i * (nz + 1) + j
            fs.append((k, k + 1, k + nz + 2, k + nz + 1))
    n = len(vs)
    vs += [v + Vector((0, .0015, 0)) for v in vs]  # 裏面
    fs += [tuple(reversed([c + n for c in f])) for f in fs]
    parts.append(link(f'lens_{lod}', vs, fs, SLOT['LENS'], recalc=False))
    # フレームの上の縁とテンプル
    rim = [Vector((x, a + b * x * x - .001, 1.694 - 1.1 * x * x + .002)) for x in [-.074, -.04, 0, .04, .074]]
    vs = []; fs = []
    seg = 6 if lod == 0 else 4
    for i, c in enumerate(rim):
        t = (rim[min(i + 1, 4)] - rim[max(i - 1, 0)]).normalized()
        u = t.cross(Vector((0, 0, 1))).normalized(); w = t.cross(u)
        for j in range(seg):
            ang = 2 * math.pi * j / seg
            vs.append(c + u * math.cos(ang) * .0028 + w * math.sin(ang) * .0028)
        if i:
            k = i * seg
            for j in range(seg): fs.append((k - seg + j, k - seg + (j + 1) % seg, k + (j + 1) % seg, k + j))
    parts.append(link(f'glasses_rim_{lod}', vs, fs, SLOT['GLASSES_FRAME']))
    for side in [-1, 1]:
        x2 = side * .074
        pts = [Vector((x2, a + b * x2 * x2, 1.688)), Vector((side * .079, cy - .02, 1.682)), Vector((side * .078, cy + .025, 1.676))]
        parts.append(ribbon(f'temple_{lod}', pts, .005, .002, SLOT['GLASSES_FRAME'], .009, samples=3 if lod == 0 else 1))
    # あごひも（耳の前と後ろから下りて合わさり、あごの下へ）
    for side in [-1, 1]:
        # 分かれ目は耳たぶの前の下
        div = Vector((side * .064, cy - .03, 1.6))
        for pts in [
            [Vector((side * .07, cy - .048, 1.712)), Vector((side * .068, cy - .044, 1.655)), div],
            [Vector((side * .062, cy + .05, 1.682)), Vector((side * .064, cy + .038, 1.625)), Vector((side * .064, cy + .004, 1.596)), div],
            [div, Vector((side * .05, cy - .042, 1.578)), Vector((side * .022, cy - .062, 1.557)), Vector((0, cy - .068, 1.553))],
        ]:
            # 髪のある高さでは髪の上を通す
            over_hair = lambda p: .0025 + .0075 * max(0.0, min(1.0, (p.z - 1.615) / .03))
            parts.append(ribbon(f'strap_{lod}', pts, .01, .0014, SLOT['STRAP'], over_hair, samples=6 if lod == 0 else 2))
    for o in parts[1:]: rigid(o, 'head')  # 髪以外は頭に固定
    return parts

def shoe(suffix, lod):
    """靴（足の骨に固定）。甲の高い樹脂の靴底、ダイヤル、クリート"""
    ankle = arm.bones['foot_' + suffix].head_local
    side = 1 if suffix == 'l' else -1
    heel_y = ankle.y + .062; length = .275
    n = 14 if lod == 0 else 8; rows = 14 if lod == 0 else 7
    def width(t): return .034 + .014 * math.sin(math.pi * min(1, t / .7) * .5) - .03 * max(0, (t - .72) / .28) ** 1.6
    def height(t):
        if t < .38: return .088 - .01 * t
        return max(.022, .083 - .075 * ((t - .38) / .62) ** 1.4)
    def cx(t): return ankle.x + side * (.006 * math.sin(math.pi * t))
    sole_top = .016
    sections = []
    for i in range(rows + 1):
        t = i / rows; y = heel_y - t * length; w = width(t); h = height(t)
        ring = []
        for j in range(n):
            ang = math.pi * j / (n - 1)  # 0..π（右から上を通って左）
            ring.append(Vector((cx(t) + math.cos(ang) * w, y, sole_top + max(0.0, math.sin(ang)) ** .7 * h)))
        sections.append(ring)
    vs = []; fs = []
    for ring in sections: vs.extend(ring)
    for i in range(rows):
        for j in range(n - 1):
            k = i * n + j
            fs.append((k, k + 1, k + n + 1, k + n))
    # かかとと つま先をふさぐ
    fs.append(tuple(range(n - 1, -1, -1)))
    last = rows * n
    fs.append(tuple(range(last, last + n)))
    # 底をふさぐ
    for i in range(rows):
        fs.append((i * n, (i + 1) * n, (i + 1) * n + n - 1, i * n + n - 1))
    upper = link(f'shoe_upper_{suffix}_{lod}', vs, fs, SLOT['SHOE'])
    # 靴底（少し大きく、黒）: 足の輪郭を上下2層にして箱状につなぐ
    vs = []; fs = []
    outline = []
    for i in range(rows + 1):
        t = i / rows; outline.append((cx(t) - width(t) - .003, heel_y + .004 - t * (length + .008)))
    for i in range(rows, -1, -1):
        t = i / rows; outline.append((cx(t) + width(t) + .003, heel_y + .004 - t * (length + .008)))
    k = len(outline)
    for z in [-.002, sole_top + .002]:
        for x, y in outline: vs.append(Vector((x, y, z)))
    for i in range(k):
        j = (i + 1) % k
        fs.append((i, j, j + k, i + k))
    fs.append(tuple(range(k - 1, -1, -1))); fs.append(tuple(range(k, 2 * k)))
    sole = link(f'shoe_sole_{suffix}_{lod}', vs, fs, SLOT['SOLE'], smooth=False)
    parts = [upper, sole]
    if lod == 0:
        # ダイヤル（外側の甲）とクリート
        t = .4; c = Vector((cx(t) + side * (width(t) - .004), heel_y - t * length, sole_top + height(t) * .82))
        out = Vector((side * .55, 0, .83)).normalized()
        bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=.012, depth=.008, location=c + out * .004)
        d = bpy.context.object; d.name = f'shoe_dial_{suffix}'
        d.rotation_mode = 'QUATERNION'; d.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(out)
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        d.data.materials.append(palette); set_slots(d, lambda _p: SLOT['SHOE_DIAL'])
        parts.append(d)
        bpy.ops.mesh.primitive_cube_add(size=1, location=(cx(.66), heel_y - .66 * length, -.006))
        cl = bpy.context.object; cl.name = f'cleat_{suffix}'; cl.scale = (.05, .065, .008)
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        cl.data.materials.append(palette); set_slots(cl, lambda _p: SLOT['SOLE'])
        parts.append(cl)
    for p in parts: rigid(p, 'foot_' + suffix)
    return parts

# ---- 背中のポケット（体の面に沿わせ、重みを写す） ----
def pockets(lod):
    kd = KDTree(len(mesh.vertices))
    for vert in mesh.vertices: kd.insert(vert.co, vert.index)
    kd.balance()
    out = []
    rows, cols = (6, 5) if lod == 0 else (3, 3)
    for x in [-.075, 0, .075]:
        vs = []; fs = []; nearest = []
        for row in range(rows):
            for col in range(cols):
                xx = x + (col / (cols - 1) - .5) * .068; zz = 1.09 + row * (.085 / (rows - 1))
                hit, normal, _, _ = body_bvh.ray_cast(Vector((xx, 1, zz)), Vector((0, -1, 0)))
                if hit is None: raise ValueError('Pocket ray missed body')
                nearest.append(kd.find(hit)[1])
                vs.append(hit + normal * (.002 + .005 * math.sin(math.pi * col / (cols - 1)) * math.sin(math.pi * row / (rows - 1))))
                if row and col: k = row * cols + col; fs.append((k - cols - 1, k - cols, k, k - 1))
        o = link(f'pocket_{lod}', vs, fs, SLOT['JERSEY'])
        for vg in human.vertex_groups: o.vertex_groups.new(name=vg.name)
        for index, source in enumerate(nearest):
            for g in mesh.vertices[source].groups: o.vertex_groups[g.group].add([index], g.weight, 'REPLACE')
        skin_to_rig(o)
        out.append(o)
    return out

# ---- ヘルメット（頭の表面に光線を当てて、そこから一定の厚みで外へ） ----
HEAD_C = Vector((0, cy + .006, 1.70))
def helmet(kind, lod):
    rings = 16 if lod == 0 else 7
    segs = 64 if lod == 0 else 24
    def rim_z(phi):  # phi=0 が前
        c = math.cos(phi)
        if kind == 'road': return 1.699 + .036 * c + (.0 if c > 0 else .012 * c)
        return 1.697 + .037 * c + (.0 if c > 0 else .03 * c)
    def clearance(d):
        back = max(0, d.y) / max(1e-6, d.length)
        up = max(0, d.z)
        if kind == 'road': return .017 + .012 * back * back + .003 * up
        return .02 + .045 * back ** 2.2 * (1 - .5 * up) + .002 * up
    def surface(theta, phi):
        d = Vector((math.sin(theta) * math.sin(phi), -math.sin(theta) * math.cos(phi), math.cos(theta)))
        loc, _, _, dist = body_bvh.ray_cast(HEAD_C, d)
        r = dist if loc is not None else .1
        return HEAD_C + d * (r + clearance(d)), d, r
    # 子午線ごとに、縁の高さになる角度を二分法で
    rim_theta = []
    for j in range(segs):
        phi = 2 * math.pi * j / segs
        lo, hi = 0.0, 2.2
        for _ in range(18):
            mid = (lo + hi) / 2
            if surface(mid, phi)[0].z > rim_z(phi): lo = mid
            else: hi = mid
        rim_theta.append(lo)
    vs = [surface(0, 0)[0]]; fs = []
    inner = []
    for i in range(1, rings + 1):
        for j in range(segs):
            phi = 2 * math.pi * j / segs
            theta = rim_theta[j] * (i / rings) ** .92
            p, d, r = surface(theta, phi)
            vs.append(p)
            if i == rings: inner.append(HEAD_C + d * (r + .006) + Vector((0, 0, -.004)))
    for j in range(segs): fs.append((0, 1 + j, 1 + (j + 1) % segs))
    for i in range(rings - 1):
        for j in range(segs):
            a = 1 + i * segs + j; b = 1 + i * segs + (j + 1) % segs
            fs.append((a, a + segs, b + segs, b))
    # 縁の厚み（内側の発泡材が見える）
    base = len(vs); vs.extend(inner); last = 1 + (rings - 1) * segs
    for j in range(segs):
        a = last + j; b = last + (j + 1) % segs
        fs.append((a, base + j, base + (j + 1) % segs, b))
    n_shell = len(fs)
    o = link(f'helmet_{kind}' + ('_lod1' if lod else ''), vs, fs, SLOT['HELMET'])
    # 縁の帯だけ内側の色
    uv = o.data.uv_layers['SLOT']
    for poly in o.data.polygons:
        if poly.index >= n_shell - segs:
            for li in poly.loop_indices: uv.data[li].uv = (SLOT['HELMET_INNER'], .5)
    rigid(o, 'head')
    return o

# ---- 一人称の腕（体の写しから胴と頭を除く） ----
set_slots(human, lambda poly: body_slot(poly.center))
fp = human.copy(); fp.data = human.data.copy(); fp.name = 'first_person_arms'; bpy.context.collection.objects.link(fp)
bm = bmesh.new(); bm.from_mesh(fp.data)
bmesh.ops.delete(bm, geom=[f for f in bm.faces if abs(f.calc_center_median().x) < .32], context='FACES')
bm.to_mesh(fp.data); bm.free()

def join(target, others, name):
    with bpy.context.temp_override(active_object=target, selected_editable_objects=[target] + others):
        bpy.ops.object.join()
    target.name = name; target.data.name = name
    return target

# 軽量版の体（減らしてから面の番号を付け直す）
lod_body = human.copy(); lod_body.data = human.data.copy(); lod_body.name = 'body_lod1_src'; bpy.context.collection.objects.link(lod_body)
for m in list(lod_body.modifiers): lod_body.modifiers.remove(m)
# 服の境目の頂点は間引かない（重み 0）
slot_uv = lod_body.data.uv_layers['SLOT']
vert_slots = {}
for poly in lod_body.data.polygons:
    s = round(slot_uv.data[poly.loop_indices[0]].uv[0])
    for vi in poly.vertices: vert_slots.setdefault(vi, set()).add(s)
keep = lod_body.vertex_groups.new(name='decimate_factor')
keep.add([vi for vi, ss in vert_slots.items() if len(ss) == 1], 1.0, 'REPLACE')
keep.add([vi for vi, ss in vert_slots.items() if len(ss) > 1], 0.0, 'REPLACE')
dec = lod_body.modifiers.new('dec', 'DECIMATE'); dec.ratio = .3
dec.vertex_group = 'decimate_factor'; dec.vertex_group_factor = 1.0
with bpy.context.temp_override(object=lod_body, active_object=lod_body):
    bpy.ops.object.modifier_apply(modifier='dec')
set_slots(lod_body, lambda poly: body_slot(poly.center))
skin_to_rig(lod_body)

# 体の小物を作ってから（光線は元の体に当てる）まとめる
detail = body_parts(0) + pockets(0) + shoe('l', 0) + shoe('r', 0)
light = body_parts(1) + pockets(1) + shoe('l', 1) + shoe('r', 1)
for o in detail + light:
    if not o.modifiers: skin_to_rig(o)
    if not o.vertex_groups:
        raise ValueError(f'{o.name} has no weights')
helmets = [helmet('road', 0), helmet('aero', 0), helmet('road', 1), helmet('aero', 1)]
body = join(human, detail, 'cyclist_body')
body_lod = join(lod_body, light, 'cyclist_body_lod1')

# ---- 書き出し ----
for o in bpy.data.objects:
    if o.type == 'MESH':
        o.data.materials.clear(); o.data.materials.append(palette)
tri = lambda o: sum(len(p.vertices) - 2 for p in o.data.polygons)
counts = {o.name: tri(o) for o in bpy.data.objects if o.type == 'MESH'}
report = {
    'source': 'MakeHuman / MPFB2 CC0 core data', 'commit': (SRC / 'commit.txt').read_text().strip(), 'height': 1.78,
    'bodyVertices': len(used), 'build': 'scripts/build-cyclist.py (openworld-cycling)', 'triangles': counts,
    'helmetCenter': [HEAD_C.x, HEAD_C.z, -HEAD_C.y],
    'bones': {n: {'head': list(b.head_local), 'tail': list(b.tail_local), 'length': b.length, 'parent': b.parent.name if b.parent else None} for n, b in arm.bones.items()},
}
(WORK / 'rig-report.json').write_text(json.dumps(report, indent=2))
(OUT / 'rig-v2.json').write_text(json.dumps(report))
bpy.ops.wm.save_as_mainfile(filepath=str(WORK / 'cyclist.blend'))
bpy.ops.export_scene.gltf(filepath=str(OUT / 'cyclist-v2.glb'), export_format='GLB', export_animations=False, export_cameras=False,
                          export_lights=False, export_texcoords=True, export_normals=True, export_morph=False)
manifest = []
for p in sorted(SRC.iterdir()):
    if p.is_file(): manifest.append({'file': p.name, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest(), 'bytes': p.stat().st_size})
(WORK / 'source-manifest.json').write_text(json.dumps(manifest, indent=2))
print('BUILD ' + json.dumps({'glbBytes': (OUT / 'cyclist-v2.glb').stat().st_size, 'triangles': counts, 'bones': len(arm.bones)}))
