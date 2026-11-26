"""歩く人のリアルな形と歩きの動きを作る（Blender 4.5 のバックグラウンド実行。町の見た目の草案 3 章）。

    "C:/Program Files/Blender Foundation/Blender 4.5/blender.exe" --background --factory-startup --python scripts/build-pedestrians.py

自転車の人（scripts/build-cyclist.py）と同じ MakeHuman / MPFB2 の CC0 人体（assets-source/rider/makehuman-v1）に、
冬の服（ダウンの上着・長いコート・短い上着・ズボン・靴）・マフラーを形で足す。新しい素材の出どころは足さない。
- 頭の形の同じ組（男性の差分・差分なし）ごとに、体型・服の違う 3 体を 1 つの形にまとめる（描く側は人ごとに 1 体だけ残す）。
- 髪・帽子は体と別に、組ごとに髪型を並べた 1 つの形にする（頭の骨に固定。描く側は人ごとに 1 つの髪型だけ残す）。
  頭の中心から放射状に光線を当てて頭の面を取り、生え際は向きごとの滑らかな式で決める（体の面を写すと縁がぎざぎざになった）。
- 色は面ごとに「色の表の番号」(src/render/pedestrian-real.ts の SLOT) を頂点ごとに持たせる（境目の頂点は分ける）。
- 歩き 1 周期（WALK コマ、左右 1 歩ずつ = 1.4m）と立ち 1 コマの、全頂点の位置と法線を書き出す（頂点の動きの画像にして InstancedMesh で動かす）。
- 足の一番低い所を各コマで地面（0）に合わせる。
書き出し: public/assets/pedestrians/pedestrians-v2.bin（形式は pedestrian-real.ts の読み込みと同じ）。
座標: Blender は +X が左、-Y が前、+Z が上（three.js では (x, z, -y)）。
"""
import bpy, bmesh, json, pathlib, gzip, math, struct, hashlib
from mathutils import Vector, Matrix, Quaternion

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / 'assets-source/rider/makehuman-v1'
OUT = ROOT / 'public/assets/pedestrians'
OUT.mkdir(parents=True, exist_ok=True)
WORK = ROOT / 'assets-source/pedestrians/v1'
WORK.mkdir(parents=True, exist_ok=True)

# pedestrian-real.ts の SLOT と同じ番号
SLOT = dict(SKIN=0, HAIR=1, EYE=2, COAT=3, TRIM=4, PANTS=5, SHOE=6, HAT=7, SCARF=8, GLOVE=9, LINING=10)
WALK = 24          # 歩き 1 周期のコマ数
STRIDE = 1.25      # 1 周期で進む距離 (m)（src/sim/pedestrians.ts の STRIDE）

# 頭の形の同じ組。variants は体型・服、styles は髪型（hair_piece の名前）
GROUPS = [
    dict(name='male', body='male', styles=['crop', 'side', 'buzz', 'receding', 'cap'], variants=[
        dict(name='down', height=1.72, coat='down', scarf=False, gloves=True, boots=True, ratio=.24),
        dict(name='long_coat', height=1.77, coat='long', scarf=False, gloves=False, boots=True, ratio=.24),
        dict(name='jacket', height=1.69, coat='short', scarf=True, gloves=False, boots=False, ratio=.24),
    ]),
    dict(name='neutral', body='neutral', styles=['bob', 'long', 'ponytail', 'bun', 'pixie', 'cap'], variants=[
        dict(name='long_coat', height=1.61, coat='long', scarf=True, gloves=False, boots=True, ratio=.24),
        dict(name='jacket', height=1.64, coat='short', scarf=False, gloves=False, boots=False, ratio=.24),
        dict(name='down', height=1.58, coat='down', scarf=False, gloves=True, boots=True, ratio=.24),
    ]),
]
TARGETS = {
    'male': [('asian-male-young.target.gz', 1.0), ('universal-male-young-averagemuscle-averageweight.target.gz', 1.0)],
    'neutral': [],
}

# ---- 元の形を読む ----
base_verts = []; base_faces = []; base_groups = {}
group = ''
for line in (SRC / 'base.obj').read_text().splitlines():
    p = line.split()
    if not p: continue
    if p[0] == 'v': base_verts.append(Vector(map(float, p[1:4])))
    elif p[0] == 'g': group = p[1]
    elif p[0] == 'f':
        f = [int(x.split('/')[0]) - 1 for x in p[1:]]
        base_groups.setdefault(group, set()).update(f)
        if group == 'body': base_faces.append(f)
target_cache = {}
def target(file):
    if file not in target_cache:
        d = {}
        for line in gzip.open(SRC / file, 'rt'):
            p = line.split()
            if len(p) == 4 and not p[0].startswith('#'): d[int(p[0])] = Vector(map(float, p[1:]))
        target_cache[file] = d
    return target_cache[file]
rigdata = json.loads((SRC / 'rig.game_engine.json').read_text())
weights = json.loads((SRC / 'weights.game_engine.json').read_text())['weights']


def build(v):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    H = v['height']
    k = H / 1.78  # 自転車の人（1.78m）の寸法からの倍率
    verts = [p.copy() for p in base_verts]
    for file, w in TARGETS[v['body']]:
        for i, d in target(file).items(): verts[i] += d * w
    bottom = min(verts[i].y for i in base_groups['body']); top = max(verts[i].y for i in base_groups['body'])
    scale = H / (top - bottom)
    coords = [Vector((p.x * scale, -p.z * scale, (p.y - bottom) * scale)) for p in verts]
    used = sorted(base_groups['body']); remap = {old: i for i, old in enumerate(used)}
    mesh = bpy.data.meshes.new('body')
    mesh.from_pydata([coords[i] for i in used], [], [[remap[i] for i in f] for f in base_faces]); mesh.update()
    body = bpy.data.objects.new('body', mesh); bpy.context.collection.objects.link(body)
    for poly in mesh.polygons: poly.use_smooth = True

    def point(data):
        if data['strategy'] == 'CUBE': ids = base_groups[data['cube_name']]
        elif data['strategy'] == 'MEAN': ids = data['vertex_indices']
        elif data['strategy'] == 'VERTEX': ids = [data['vertex_index']]
        else: raise ValueError(data)
        return sum((coords[i] for i in ids), Vector()) / len(ids)
    arm = bpy.data.armatures.new('skeleton'); rig = bpy.data.objects.new('rig', arm); bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig; rig.select_set(True); bpy.ops.object.mode_set(mode='EDIT')
    for name, data in rigdata.items():
        b = arm.edit_bones.new(name); b.head = point(data['head']); b.tail = point(data['tail']); b.roll = data['roll']
    for name, data in rigdata.items():
        if data['parent']: arm.edit_bones[name].parent = arm.edit_bones[data['parent']]
    bpy.ops.object.mode_set(mode='OBJECT')
    for name, items in weights.items():
        vg = body.vertex_groups.new(name=name)
        for old, w in items:
            if old in remap: vg.add([remap[old]], w, 'REPLACE')
    eyes = [point({'strategy': 'CUBE', 'cube_name': f'joint-{s}-eye'}) for s in ['l', 'r']]

    def skin(obj):
        mod = obj.modifiers.new('skin', 'ARMATURE'); mod.object = rig; obj.parent = rig

    def rigid(obj, bone, others=()):
        """bone に重み 1（others は [(骨, 重みの関数(点))]）"""
        vg = obj.vertex_groups.new(name=bone)
        if not others:
            vg.add(list(range(len(obj.data.vertices))), 1, 'REPLACE')
        else:
            gs = [(obj.vertex_groups.new(name=b), fn) for b, fn in others]
            for vert in obj.data.vertices:
                rest = 1.0
                for g, fn in gs:
                    w = fn(vert.co); rest -= w
                    if w > 0: g.add([vert.index], w, 'REPLACE')
                vg.add([vert.index], max(0.0, rest), 'REPLACE')
        skin(obj)

    # 髪を作るための頭の面（減らす前の細かい形。頭の中心から光線を当てる）
    from mathutils.bvhtree import BVHTree
    hv = [vv.co.copy() for vv in mesh.vertices]
    hf = [p.vertices[:] for p in mesh.polygons if p.center.z > 1.42 * k]
    head = dict(bvh=BVHTree.FromPolygons(hv, hf), k=k, height=H)
    headverts = [p for p in hv if p.z > 1.58 * k]
    hcy = (min(p.y for p in headverts) + max(p.y for p in headverts)) * .5
    head['hc'] = Vector((0, hcy, (eyes[0].z + eyes[1].z) / 2 + .004 * k))

    # ---- 服の境目に辺を入れる ----
    hem = {'down': .90, 'long': .97, 'short': .88}[v['coat']] * k
    collar = 1.50 * k
    neck = 1.535 * k
    boots = (.24 if v['boots'] else .105) * k
    bm = bmesh.new(); bm.from_mesh(mesh)
    planes = [(Vector((0, 0, z)), Vector((0, 0, 1))) for z in [hem, collar, neck, boots]]
    wrists = {}
    for s in ['l', 'r']:
        b = arm.bones['lowerarm_' + s]; d = (b.tail_local - b.head_local).normalized()
        pt = b.tail_local - d * .03 * k
        wrists[s] = (pt, d); planes.append((pt, d))
    for pt, d in planes:
        bmesh.ops.bisect_plane(bm, geom=list(bm.verts) + list(bm.edges) + list(bm.faces), plane_co=pt, plane_no=d, dist=.00001, clear_inner=False, clear_outer=False)
    # 靴の中に隠れる足先は消す（靴の形を別に足す）
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.calc_center_median().z < .1 * k], context='FACES')
    bm.to_mesh(mesh); bm.free(); mesh.update()

    def is_hand(p):
        s = 'l' if p.x > 0 else 'r'
        pt, d = wrists[s]
        return abs(p.x) > .25 * k and p.z > .7 * k and (p - pt).dot(d) > 0

    def slot_of(p):
        if p.z < boots: return SLOT['SHOE']
        if is_hand(p): return SLOT['GLOVE'] if v['gloves'] else SLOT['SKIN']
        if p.z > neck: return SLOT['SKIN']
        if p.z > collar: return SLOT['SCARF'] if v['scarf'] else SLOT['TRIM']
        if p.z > hem or abs(p.x) > .25 * k: return SLOT['COAT']
        return SLOT['PANTS']

    # 服のふくらみ（頂点を法線の向きへ出す量）
    puff = {'COAT': {'down': .028, 'long': .016, 'short': .013}[v['coat']], 'TRIM': .012, 'SCARF': .02, 'PANTS': .007, 'SHOE': .014, 'GLOVE': .004, 'SKIN': 0}
    names = {s: n for n, s in SLOT.items()}

    def vertex_slots():
        out = {}
        for poly in mesh.polygons:
            s = slot_of(poly.center)
            for vi in poly.vertices: out.setdefault(vi, []).append(s)
        return out
    vslot = vertex_slots()
    # 1. 服と靴の所をなめらかにする（体の凹凸（胸・へそ・筋肉・足の指）が服の上に出ないように）
    bm = bmesh.new(); bm.from_mesh(mesh); bm.verts.ensure_lookup_table()
    cv = [bm.verts[i] for i, ss in vslot.items() if SLOT['SKIN'] not in ss and SLOT['GLOVE'] not in ss]
    sv = [bm.verts[i] for i, ss in vslot.items() if set(ss) == {SLOT['SHOE']}]
    for _ in range(14):
        bmesh.ops.smooth_vert(bm, verts=cv, factor=.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    bm.to_mesh(mesh); bm.free(); mesh.update()
    # 2. 三角形を減らす（服の境目は残し、顔は細かく残す）
    keep = body.vertex_groups.new(name='decimate_factor')
    for vi, ss in vslot.items():
        if len(set(ss)) > 1: w = 0.0
        elif mesh.vertices[vi].co.z > neck: w = .25
        else: w = 1.0
        keep.add([vi], w, 'REPLACE')
    dec = body.modifiers.new('dec', 'DECIMATE'); dec.ratio = v['ratio']
    dec.vertex_group = 'decimate_factor'; dec.vertex_group_factor = 1.0
    with bpy.context.temp_override(object=body, active_object=body):
        bpy.ops.object.modifier_apply(modifier='dec')
    body.vertex_groups.remove(body.vertex_groups['decimate_factor'])
    # 3. 減らした形で、服をふくらませる
    vslot = vertex_slots()
    for vert in mesh.vertices:
        ss = vslot.get(vert.index, [SLOT['SKIN']])
        off = max(puff.get(names[s], 0) for s in ss)
        # 服の端（肌の隣）は半分だけ（段差を小さく）
        if SLOT['SKIN'] in ss and len(set(ss)) > 1: off *= .5
        # 袖は胴より薄く
        if abs(vert.co.x) > .25 * k and SLOT['COAT'] in ss: off *= .7
        vert.co += vert.normal * off
    mesh.update()
    skin(body)
    parts = [body]

    def link(name, vs, fs, slot, smooth=True):
        me = bpy.data.meshes.new(name); me.from_pydata(vs, [], fs); me.update()
        bm = bmesh.new(); bm.from_mesh(me); bmesh.ops.recalc_face_normals(bm, faces=bm.faces); bm.to_mesh(me); bm.free(); me.update()
        for poly in me.polygons: poly.use_smooth = smooth
        o = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(o)
        o['slot'] = slot
        return o

    # ---- 頭まわり ----
    headverts = [vv.co.copy() for vv in mesh.vertices if vv.co.z > 1.58 * k]
    cy = (min(p.y for p in headverts) + max(p.y for p in headverts)) * .5
    hc = Vector((0, cy, 1.69 * k))
    # 目（目の穴に球）
    for e in eyes:
        bpy.ops.mesh.primitive_uv_sphere_add(segments=8, ring_count=6, radius=.0135 * k, location=e)
        o = bpy.context.object; o['slot'] = SLOT['EYE']
        rigid(o, 'head'); parts.append(o)

    if v['scarf']:
        nb = arm.bones['neck_01'].head_local
        bpy.ops.mesh.primitive_torus_add(major_segments=16, minor_segments=6, major_radius=.07 * k, minor_radius=.026 * k,
                                         location=(0, nb.y + .01 * k, nb.z - .01 * k))
        o = bpy.context.object; o.scale = (1.05, 1.0, .85); bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        o['slot'] = SLOT['SCARF']
        rigid(o, 'neck_01', [('spine_03', lambda p: .5)])
        parts.append(o)

    # ---- 靴（足の骨に固定。甲と底） ----
    for s_, side in [('l', 1), ('r', -1)]:
        ankle = arm.bones['foot_' + s_].head_local
        heel_y = ankle.y + .06 * k; length = .265 * k
        n, rows = 10, 9
        def width(t): return (.036 + .012 * math.sin(math.pi * min(1, t / .7) * .5) - .028 * max(0, (t - .72) / .28) ** 1.6) * k
        def height(t): return (.095 - .012 * t if t < .38 else max(.03, .09 - .065 * ((t - .38) / .62) ** 1.3)) * k
        sole_top = .022 * k
        vs = []; fs = []
        for i in range(rows + 1):
            t = i / rows; y = heel_y - t * length
            for j in range(n):
                ang = math.pi * j / (n - 1)
                vs.append(Vector((ankle.x + math.cos(ang) * width(t), y, sole_top + max(0.0, math.sin(ang)) ** .7 * height(t))))
        for i in range(rows):
            for j in range(n - 1):
                q = i * n + j
                fs.append((q, q + 1, q + n + 1, q + n))
        fs.append(tuple(range(n - 1, -1, -1))); fs.append(tuple(range(rows * n, rows * n + n)))
        for i in range(rows): fs.append((i * n, (i + 1) * n, (i + 1) * n + n - 1, i * n + n - 1))
        upper = link('shoe_' + s_, vs, fs, SLOT['SHOE'])
        rigid(upper, 'foot_' + s_); parts.append(upper)
        outline = [(ankle.x - width(i / rows) - .003 * k, heel_y + .004 * k - i / rows * (length + .008 * k)) for i in range(rows + 1)]
        outline += [(ankle.x + width(i / rows) + .003 * k, heel_y + .004 * k - i / rows * (length + .008 * k)) for i in range(rows, -1, -1)]
        m = len(outline); vs = []; fs = []
        for z in [0.0, sole_top + .002 * k]:
            for x, y in outline: vs.append(Vector((x, y, z)))
        for i in range(m): fs.append((i, (i + 1) % m, (i + 1) % m + m, i + m))
        fs.append(tuple(range(m - 1, -1, -1))); fs.append(tuple(range(m, 2 * m)))
        sole = link('sole_' + s_, vs, fs, SLOT['LINING'], smooth=False)
        rigid(sole, 'foot_' + s_); parts.append(sole)

    # ---- 長いコートの裾（腰から膝まで。上は骨盤、下は左右の腿に重みを移す） ----
    if v['coat'] == 'long':
        ring = [vv.co for vv in mesh.vertices if hem - .03 * k < vv.co.z < hem + .03 * k and abs(vv.co.x) < .25 * k]
        rx = max(abs(p.x) for p in ring) + .03 * k
        y0 = min(p.y for p in ring); y1 = max(p.y for p in ring)
        cyh = (y0 + y1) / 2; ry = (y1 - y0) / 2 + .03 * k
        rows, segs = 6, 20
        ztop, zbot = hem + .01 * k, .48 * k
        vs = []; fs = []
        for i in range(rows + 1):
            t = i / rows; z = ztop + (zbot - ztop) * t
            f = 1 + .3 * t
            for j in range(segs):
                a = 2 * math.pi * j / segs
                vs.append(Vector((math.sin(a) * rx * f, cyh + math.cos(a) * ry * f * (1 + .12 * t), z)))
        for i in range(rows):
            for j in range(segs):
                a = i * segs + j; b = i * segs + (j + 1) % segs
                fs.append((a, b, b + segs, a + segs))
        # 裏は描く側で両面にして見せる（内張りを重ねると、脚で押された所で表とちらついた）
        outer = link('coat_skirt', vs, fs, SLOT['COAT'])
        for o in [outer]:
            depth = lambda p: max(0.0, min(1.0, (ztop - p.z) / (ztop - zbot)))
            side = lambda p: max(-1.0, min(1.0, p.x / rx))
            rigid(o, 'pelvis', [('thigh_l', lambda p: .9 * depth(p) * (.5 + .5 * side(p))), ('thigh_r', lambda p: .9 * depth(p) * (.5 - .5 * side(p)))])
            parts.append(o)

    # ---- 色の番号を面に付け、1 つにまとめる ----
    def face_slot(o, poly):
        if 'slot' in o: return o['slot']
        return slot_of(poly.center)
    for o in parts:
        me = o.data
        for l in list(me.uv_layers): me.uv_layers.remove(l)
        uv = me.uv_layers.new(name='SLOT')
        for poly in me.polygons:
            s = face_slot(o, poly)
            for li in poly.loop_indices: uv.data[li].uv = (s, .5)
    # すべての部品が同じ骨の名前の重みを持つように
    for o in parts:
        for name in rigdata:
            if name not in o.vertex_groups: o.vertex_groups.new(name=name)
    with bpy.context.temp_override(active_object=body, selected_editable_objects=parts):
        bpy.ops.object.join()
    person = body
    # 三角形にし、色の境目で頂点を分ける
    bm = bmesh.new(); bm.from_mesh(person.data)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    uvl = bm.loops.layers.uv['SLOT']
    fslot = lambda f: round(f.loops[0][uvl].uv[0])
    border = [e for e in bm.edges if len(e.link_faces) == 2 and fslot(e.link_faces[0]) != fslot(e.link_faces[1])]
    bmesh.ops.split_edges(bm, edges=border)
    bm.to_mesh(person.data); bm.free(); person.data.update()
    return person, rig, head


def aim(rig, name, direction):
    """骨を armature の空間の向き direction に向ける（親は先に向けておく）"""
    pb = rig.pose.bones[name]; bone = pb.bone
    rest = bone.matrix_local.to_3x3()
    rest_dir = (bone.tail_local - bone.head_local).normalized()
    q = rest_dir.rotation_difference(direction.normalized())
    pb.matrix = Matrix.Translation(pb.head) @ (q.to_matrix() @ rest).to_4x4()
    bpy.context.view_layer.update()


def curve(keys, u):
    """周期 1 の曲線（Catmull-Rom）。keys は [(u, 値)]、最初と最後の u は 0 と 1 で同じ値"""
    u %= 1.0
    n = len(keys) - 1
    for i in range(n):
        u0, v0 = keys[i]; u1, v1 = keys[i + 1]
        if u <= u1:
            t = (u - u0) / (u1 - u0)
            vm = keys[i - 1][1] if i > 0 else keys[n - 1][1]
            vp = keys[i + 2][1] if i + 2 <= n else keys[1][1]
            t2 = t * t; t3 = t2 * t
            return .5 * ((2 * v0) + (-vm + v1) * t + (2 * vm - 5 * v0 + 4 * v1 - vp) * t2 + (-vm + 3 * v0 - 3 * v1 + vp) * t3)
    return keys[-1][1]


# 歩行の関節の角度（度）。u は片脚の踵が着いた時から 1 周期（0.6 で蹴り出し、残りが振り出し）。
# 腿は前が正、膝は曲げが正、足は地面に対するつま先の上がりが正
HIP = [(0, 19), (.12, 16), (.3, 5), (.5, -9), (.6, -8), (.72, 5), (.86, 20), (.94, 21), (1, 19)]
KNEE = [(0, 3), (.12, 15), (.25, 9), (.42, 4), (.55, 14), (.65, 40), (.73, 56), (.84, 32), (.94, 6), (1, 3)]
FOOT = [(0, 13), (.07, 2), (.12, 0), (.45, 0), (.55, -9), (.63, -27), (.7, -20), (.8, -5), (.92, 7), (1, 13)]


def turn(rig, name, yaw=0.0, roll=0.0, pitch=0.0):
    """骨を休みの姿勢の向きから armature の空間で回す（上下の軸・前後の軸・左右の軸の順、度）"""
    pb = rig.pose.bones[name]; bone = pb.bone
    R = Matrix.Rotation(math.radians(yaw), 3, 'Z') @ Matrix.Rotation(math.radians(roll), 3, 'Y') @ Matrix.Rotation(math.radians(pitch), 3, 'X')
    pb.matrix = Matrix.Translation(pb.head) @ (R @ bone.matrix_local.to_3x3()).to_4x4()
    bpy.context.view_layer.update()


def pose(rig, phase, still):
    for pb in rig.pose.bones:
        pb.rotation_mode = 'QUATERNION'; pb.rotation_quaternion = (1, 0, 0, 0); pb.location = (0, 0, 0)
    bpy.context.view_layer.update()
    tau = 2 * math.pi
    # 腰のひねり（前に出た脚の側の腰が前）と傾き（振り出す脚の側が下がる）、胴のひねり返し、少し前へ傾ける
    yaw = 0.0 if still else 5.0 * math.cos(tau * phase)
    roll = 0.0 if still else 2.5 * math.sin(tau * phase * 2 - .6)
    turn(rig, 'pelvis', yaw, roll)
    turn(rig, 'spine_01', yaw * .4, roll * .4, -2 if not still else 0)
    turn(rig, 'spine_02', -yaw * .2, 0, -3 if not still else -1)
    turn(rig, 'spine_03', -yaw * .7, -roll * .3, -3 if not still else -1)
    turn(rig, 'neck_01', -yaw * .3, 0, 2)
    turn(rig, 'head', 0, 0, 0)
    shoulder = Matrix.Rotation(math.radians(-yaw * .7), 3, 'Z')
    for s, side, off in [('l', 1, 0.0), ('r', -1, .5)]:
        u = (phase + off) % 1
        if still:
            a, knee, toe, swing, elbow = 0.0, math.radians(3), 0.0, 0.0, math.radians(9)
        else:
            a = math.radians(curve(HIP, u))
            knee = math.radians(curve(KNEE, u))
            toe = math.radians(curve(FOOT, u))
            # 腕は同じ側の脚と逆に、少し遅れて振る。前へ振る時に肘を曲げる
            arm = -.55 * (curve(HIP, u - .04) - 6)
            swing = math.radians(arm)
            elbow = math.radians(13 + .6 * max(0.0, arm) + 3 * math.sin(tau * u))
        b = rig.data.bones['thigh_' + s]; lat = (b.tail_local - b.head_local).normalized().x * .6
        c = math.sqrt(1 - lat * lat)
        aim(rig, 'thigh_' + s, Vector((lat, -math.sin(a) * c, -math.cos(a) * c)))
        aim(rig, 'calf_' + s, Vector((lat * .5, -math.sin(a - knee), -math.cos(a - knee))))
        f = rig.data.bones['foot_' + s]; fd = (f.tail_local - f.head_local).normalized()
        pitch = math.atan2(-fd.z, -fd.y) - toe
        aim(rig, 'foot_' + s, Vector((fd.x, -math.cos(pitch), -math.sin(pitch))))
        aim(rig, 'upperarm_' + s, shoulder @ Vector((side * .16, -math.sin(swing), -math.cos(swing))))
        aim(rig, 'lowerarm_' + s, shoulder @ Vector((side * .08, -math.sin(swing + elbow), -math.cos(swing + elbow))))
        aim(rig, 'hand_' + s, shoulder @ Vector((side * .06, -math.sin(swing + elbow + .12), -math.cos(swing + elbow + .12))))
        # 指を軽く曲げる（開いたままだと不自然だった）
        for fn in ['index', 'middle', 'ring', 'pinky']:
            for j, deg in [('01', 22), ('02', 28), ('03', 18)]:
                pb = rig.pose.bones[f'{fn}_{j}_{s}']
                pb.rotation_quaternion = Quaternion((1, 0, 0), math.radians(deg))
        bpy.context.view_layer.update()


def bake(person, rig, scale):
    """全頂点の位置・法線（コマごと）と、頭の動き（休みの姿勢の頭の点を各コマの位置へ移す 3×4 の行列。scale 倍した参照の頭に掛ける）"""
    frames = []; heads = []
    dg = bpy.context.evaluated_depsgraph_get()
    C = Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, -1, 0, 0), (0, 0, 0, 1)))  # Blender → three.js
    R = rig.data.bones['head'].matrix_local
    for fi in range(WALK + 1):
        still = fi == WALK
        pose(rig, fi / WALK, still)
        dg.update()
        ev = person.evaluated_get(dg)
        me = ev.to_mesh()
        P = [(vv.co.x, vv.co.z, -vv.co.y) for vv in me.vertices]
        N = [(vv.normal.x, vv.normal.z, -vv.normal.y) for vv in me.vertices]
        ev.to_mesh_clear()
        low = min(p[1] for p in P)
        frames.append(([(x, y - low, z) for x, y, z in P], N))
        B = Matrix.Translation((0, 0, -low)) @ rig.pose.bones['head'].matrix @ R.inverted() @ Matrix.Scale(scale, 4)
        B3 = C @ B @ C.inverted()
        heads.append([B3[r][c] for r in range(3) for c in range(4)])
    return frames, heads


# ---- 髪型 ----
def smooth01(x):
    x = max(0.0, min(1.0, x)); return x * x * (3 - 2 * x)


def ang(phi):
    """前からの角度の大きさ（0〜180 度）"""
    return abs(((phi + 180) % 360) - 180)


def hairline(phi, front, temple, side, back, burn=None):
    """向き phi（0 が前、正が左、度）ごとの生え際の高さ（頭の中心からの仰角、度）。
    前・こめかみ・もみあげ（耳の前、無ければ耳の上より 14 度下）・耳の上・うなじの値を滑らかにつなぐ"""
    a = ang(phi)
    burn = side - 14 if burn is None else burn
    keys = [(0, front), (40, temple), (68, burn), (92, side), (130, (side + back) / 2), (180, back)]
    for (a0, v0), (a1, v1) in zip(keys, keys[1:]):
        if a <= a1:
            t = smooth01((a - a0) / (a1 - a0)); return v0 + (v1 - v0) * t
    return back


def head_dir(phi, e):
    pr, er = math.radians(phi), math.radians(e)
    return Vector((math.sin(pr) * math.cos(er), -math.cos(pr) * math.cos(er), math.sin(er)))


def hair_sheet(head, end, thick, drape=None, cols=40, rows=12, drows=6, top=88.0):
    """頭を覆う髪の面。end(phi) は生え際の仰角、thick(phi, e, t) は頭の面からの厚み（1.78m の体の値。t は上 0〜生え際 1）、
    drape(phi) は生え際から真下へ垂らす先の高さ（None なら垂らさない）。頭の中心からの光線で頭の面を取る"""
    bvh, hc, k = head['bvh'], head['hc'], head['k']
    vs = []; fs = []
    nr = rows + (drows if drape else 0)
    for j in range(cols):
        phi = 360.0 * j / cols
        e_end = end(phi)
        col = []
        last = None
        for i in range(rows + 1):
            t = i / rows
            e = top + (e_end - top) * t
            d = head_dir(phi, e)
            hit, nor, _, _ = bvh.ray_cast(hc, d)
            if hit is None:
                hit = hc + d * .1 * k; nor = d
            out = (nor + d).normalized()
            p = hit + out * thick(phi, e, t) * k
            col.append(p); last = (p, out)
        if drape:
            tip = drape(phi)
            p0, out0 = last
            h = Vector((out0.x, out0.y, 0)); h = h.normalized() if h.length > 1e-6 else Vector((0, 1, 0))
            for i in range(1, drows + 1):
                t = i / drows
                z = p0.z + (tip - p0.z) * t if tip is not None and tip < p0.z else p0.z
                col.append(Vector((p0.x, p0.y, z)) + h * (.012 * k * math.sin(math.pi * t * .8) if tip is not None else 0))
        vs.extend(col)
    n = nr + 1
    for j in range(cols):
        j2 = (j + 1) % cols
        for i in range(nr):
            a, b, c, d = j * n + i, j2 * n + i, j2 * n + i + 1, j * n + i + 1
            if (vs[a] - vs[d]).length < 1e-5 and (vs[b] - vs[c]).length < 1e-5: continue
            fs.append((a, d, c, b))
    # 頂の穴をふさぐ
    ctr = len(vs); vs.append(sum((vs[j * n] for j in range(cols)), Vector()) / cols + Vector((0, 0, .003 * k)))
    for j in range(cols): fs.append((ctr, j * n, ((j + 1) % cols) * n))
    return vs, fs


def tube(pts, r0, r1, segs=8):
    vs = []; fs = []
    for i, p in enumerate(pts):
        t = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        u = t.cross(Vector((1, 0, 0))).normalized(); w = t.cross(u)
        r = r0 + (r1 - r0) * i / (len(pts) - 1)
        for j in range(segs):
            a = 2 * math.pi * j / segs
            vs.append(p + (u * math.cos(a) + w * math.sin(a)) * r)
    for i in range(len(pts) - 1):
        for j in range(segs):
            a = i * segs + j; b = i * segs + (j + 1) % segs
            fs.append((a, b, b + segs, a + segs))
    vs.append(pts[-1]); c = len(vs) - 1
    for j in range(segs): fs.append(((len(pts) - 1) * segs + (j + 1) % segs, (len(pts) - 1) * segs + j, c))
    return vs, fs


def on_head(head, phi, e, off):
    bvh, hc, k = head['bvh'], head['hc'], head['k']
    d = head_dir(phi, e)
    hit, nor, _, _ = bvh.ray_cast(hc, d)
    return (hit if hit is not None else hc + d * .1 * k) + d * off * k


def hair_piece(style, head):
    """髪型 1 つ: [(頂点, 面, 色の番号)]。厚みなどの寸法は 1.78m の体の値（k 倍する）"""
    k = head['k']
    zk = lambda z: z * k
    taper = lambda base, t, edge=.0025: edge + (base - edge) * (1 - smooth01((t - .72) / .28))
    # 前の生え際は薄くしすぎない（前髪の厚みが残る）。横・後ろは刈り上げのように薄く
    def men(phi, e, t, top, side, fringe):
        a = ang(phi)
        base = side + (top - side) * smooth01((e - 15) / 55)
        edge = fringe * (1 - smooth01((a - 30) / 30)) + .0025
        return taper(base, t, edge)
    if style == 'crop':
        return [(*hair_sheet(head, lambda phi: hairline(phi, 31, 22, 10, -30), lambda phi, e, t: men(phi, e, t, .026, .009, .009)), SLOT['HAIR'])]
    if style == 'side':
        def th(phi, e, t):
            a = ((phi + 180) % 360) - 180
            part = .01 * smooth01((a + 10) / 40) * (1 - smooth01((a - 100) / 40))  # 左へ流した分の厚み
            return men(phi, e, t, .03, .01, .012) + part * (1 - smooth01((t - .8) / .2))
        return [(*hair_sheet(head, lambda phi: hairline(phi, 27, 20, 10, -28), th), SLOT['HAIR'])]
    if style == 'buzz':
        return [(*hair_sheet(head, lambda phi: hairline(phi, 34, 24, 10, -30), lambda phi, e, t: men(phi, e, t, .008, .005, .003)), SLOT['HAIR'])]
    if style == 'receding':
        return [(*hair_sheet(head, lambda phi: hairline(phi, 56, 44, 8, -30, burn=-4), lambda phi, e, t: men(phi, e, t, .012, .007, .004)), SLOT['HAIR'])]
    if style == 'pixie':
        return [(*hair_sheet(head, lambda phi: hairline(phi, 24, 14, 4, -34), lambda phi, e, t: taper(.012 + .012 * smooth01((e - 20) / 50), t, .004)), SLOT['HAIR'])]
    if style == 'cap':
        # ニット帽（折り返しの分だけ下を厚く）と、帽子の下から見える短い髪
        cap = hair_sheet(head, lambda phi: hairline(phi, 20, 13, 4, -14), lambda phi, e, t: .02 + .007 * smooth01((t - .78) / .12) - .006 * smooth01((t - .97) / .03), rows=14)
        under = hair_sheet(head, lambda phi: hairline(phi, 30, 18, 2, -32), lambda phi, e, t: taper(.008, t))
        return [(*cap, SLOT['HAT']), (*under, SLOT['HAIR'])]
    # 長い髪: 前は前髪（額の途中まで）、横から後ろは耳を覆って下へ垂らす
    def framed_end(bang, side_e):
        return lambda phi: bang + (side_e - bang) * smooth01((ang(phi) - 32) / 22)
    vol = lambda phi, e, t: .012 + .014 * smooth01((e - 10) / 60) + .006 * smooth01(t / .6)
    if style == 'bob':
        return [(*hair_sheet(head, framed_end(20, -18), vol, lambda phi: zk(1.555) if ang(phi) > 50 else None), SLOT['HAIR'])]
    if style == 'long':
        # 横は肩の上、後ろは肩甲骨の上まで
        return [(*hair_sheet(head, framed_end(26, -16), vol, lambda phi: zk(1.47 - .05 * smooth01((ang(phi) - 90) / 60)) if ang(phi) > 50 else None), SLOT['HAIR'])]
    pulled = hair_sheet(head, lambda phi: hairline(phi, 36, 22, 8, -28), lambda phi, e, t: taper(.007 + .005 * smooth01((e - 20) / 50), t))
    if style == 'ponytail':
        s0 = on_head(head, 180, 8, .012)
        pts = [s0, s0 + Vector((0, .04, -.02)) * k, s0 + Vector((0, .055, -.08)) * k, s0 + Vector((0, .05, -.15)) * k, s0 + Vector((0, .04, -.2)) * k]
        return [(*pulled, SLOT['HAIR']), (*tube(pts, .034 * k, .014 * k), SLOT['HAIR'])]
    if style == 'bun':
        c = on_head(head, 180, 24, .045)
        bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=8, radius=.042 * k, location=c)
        o = bpy.context.object; o.scale = (1.15, .9, .95); bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        vs = [vv.co.copy() for vv in o.data.vertices]; fs = [p.vertices[:] for p in o.data.polygons]
        bpy.data.objects.remove(o, do_unlink=True)
        return [(*pulled, SLOT['HAIR']), (vs, fs, SLOT['HAIR'])]
    raise ValueError(style)


def hair_group(styles, head):
    """髪型を並べた 1 つの形（休みの姿勢の参照の頭の座標、three.js の向き）。頂点ごとに髪型の番号と色の番号"""
    P = []; Nn = []; slots = []; style_of = []; idx = []
    hc = head['hc']
    for si, st in enumerate(styles):
        for vs, fs, slot in hair_piece(st, head):
            me = bpy.data.meshes.new('hair'); me.from_pydata(vs, [], fs); me.update()
            bm = bmesh.new(); bm.from_mesh(me); bmesh.ops.triangulate(bm, faces=bm.faces); bm.to_mesh(me); bm.free(); me.update()
            # 面の向きを外（頭の中心から離れる向き）にそろえる
            out = sum((p.normal.dot(p.center - hc) for p in me.polygons), 0.0)
            flip = out < 0
            base = len(P)
            for vv in me.vertices:
                n = -vv.normal if flip else vv.normal
                P.append((vv.co.x, vv.co.z, -vv.co.y)); Nn.append((n.x, n.z, -n.y)); slots.append(slot); style_of.append(si)
            for p in me.polygons:
                tri = list(p.vertices)
                if flip: tri.reverse()
                idx += [base + i for i in tri]
            bpy.data.meshes.remove(me)
    return P, Nn, slots, style_of, idx


def q16(frames_P, lo, hi):
    out = bytearray()
    for P in frames_P:
        for p in P: out += struct.pack('<3H', *[round((p[i] - lo[i]) / ((hi[i] - lo[i]) or 1) * 65535) for i in range(3)])
    return bytes(out)


def n8(frames_N):
    out = bytearray()
    for N in frames_N:
        for n in N:
            l = math.sqrt(n[0] ** 2 + n[1] ** 2 + n[2] ** 2) or 1
            out += struct.pack('<4b', *[max(-127, min(127, round(n[i] / l * 127))) for i in range(3)], 0)
    return bytes(out)


header = dict(version=2, walkFrames=WALK, stride=STRIDE, slots=SLOT, source='MakeHuman / MPFB2 CC0 core data', commit=(SRC / 'commit.txt').read_text().strip(), groups=[])
blobs = []
offset = 0


def add(b):
    global offset
    pad = (-len(b)) % 4
    blobs.append(b + b'\0' * pad)
    o = offset; offset += len(b) + pad
    return o


for g in GROUPS:
    href = g['variants'][0]['height']
    all_frames = [[] for _ in range(WALK + 1)]; all_normals = [[] for _ in range(WALK + 1)]
    slots = []; var = []; idx = []; heads = []
    hair = None
    for vi, v in enumerate(g['variants']):
        v = dict(v, body=g['body'])
        person, rig, head = build(v)
        frames, hm = bake(person, rig, v['height'] / href)
        me = person.data; uvl = me.uv_layers['SLOT']
        vs = [0] * len(me.vertices)
        for poly in me.polygons:
            for vx in poly.vertices: vs[vx] = round(uvl.data[poly.loop_indices[0]].uv[0])
        base = len(slots)
        slots += vs; var += [vi] * len(vs)
        for poly in me.polygons: idx += [base + i for i in poly.vertices]
        for f, (P, N) in enumerate(frames):
            all_frames[f] += P; all_normals[f] += N
        heads += [c for m in hm for c in m]
        bpy.ops.wm.save_as_mainfile(filepath=str(WORK / f"{g['name']}_{v['name']}.blend"))
        print('VARIANT', g['name'], v['name'], len(vs), len(me.polygons))
        if vi == 0:
            # 髪は参照（最初の体）の頭で作る（ほかの体は頭の行列の倍率で合わせる）
            hair = hair_group(g['styles'], head)
    hP, hN, hS, hT, hI = hair
    lo = [min(p[i] for P in all_frames for p in P) for i in range(3)]
    hi = [max(p[i] for P in all_frames for p in P) for i in range(3)]
    info = dict(name=g['name'], styles=g['styles'], variants=[dict(name=v['name'], height=v['height']) for v in g['variants']],
                vertices=len(slots), triangles=len(idx) // 3, lo=lo, hi=hi,
                index=add(struct.pack(f'<{len(idx)}H', *idx)), slot=add(bytes(slots)), variant=add(bytes(var)),
                position=add(q16(all_frames, lo, hi)), normal=add(n8(all_normals)),
                heads=add(struct.pack(f'<{len(heads)}f', *heads)),
                hair=dict(vertices=len(hP), triangles=len(hI) // 3, index=add(struct.pack(f'<{len(hI)}H', *hI)), slot=add(bytes(hS)), style=add(bytes(hT)),
                          position=add(struct.pack(f'<{len(hP) * 3}f', *[c for p in hP for c in p])), normal=add(n8([hN]))))
    header['groups'].append(info)
    print('GROUP', g['name'], info['vertices'], info['triangles'], 'hair', info['hair']['vertices'], info['hair']['triangles'])
hj = json.dumps(header).encode()
hj += b' ' * ((-len(hj)) % 4)
data = b'PED2' + struct.pack('<I', len(hj)) + hj + b''.join(blobs)
old = OUT / 'pedestrians-v1.bin'
if old.exists(): old.unlink()
(OUT / 'pedestrians-v2.bin').write_bytes(data)
(WORK / 'build-report.json').write_text(json.dumps(dict(header, bytes=len(data)), indent=2))
manifest = [{'file': p.name, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(SRC.iterdir()) if p.is_file()]
(WORK / 'source-manifest.json').write_text(json.dumps(manifest, indent=2))
print('BUILD', len(data))
