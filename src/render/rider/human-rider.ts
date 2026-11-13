// downhill-3D の src/render/ から移した（2026-11-13）。元は1行が長いので、ここで手を入れる時に読みやすく整える。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RiderModel as LegacyRider, type RiderPose } from "./rider.ts";
import { bone, connect, shape, joint, v } from "./models.ts";

type Bind = { bone: THREE.Bone; head: THREE.Vector3; direction: THREE.Vector3; rotation: THREE.Quaternion; local: THREE.Quaternion; localPosition: THREE.Vector3; length: number };
type RigData = {bones:Record<string,{head:number[];tail:number[];length:number}>};
/** Continuous CC0 human mesh; all pose targets are in bicycle metres. */
export class HumanRider {
  group = new THREE.Group();
  private fallback = new LegacyRider();
  private model?: THREE.Group;
  private bindings = new Map<string, Bind>();
  private pose: RiderPose = {phase:0,sprint:0,tuck:false,steeringAngle:0,firstPerson:false};
  private error: string | null = null;
  private meshes: {mesh:THREE.Mesh;firstPerson:boolean}[]=[];
  private reachExcess=0;
  private hardware = new THREE.Group();
  private cranks = [-1,1].map(side=>({side,crank:bone(this.hardware,'#aab7b9'),pedal:shape(this.hardware,'#263039',[0,0,0],[.1,.016,.075],false)}));
  constructor() {
    this.group.name='road-cyclist';this.group.add(this.fallback.group,this.hardware);this.hardware.visible=false;
    Promise.all([
      new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}assets/rider/cyclist.glb`),
      fetch(`${import.meta.env.BASE_URL}assets/rider/rig.json`).then(r=>{if(!r.ok)throw new Error(`rider rig HTTP ${r.status}`);return r.json() as Promise<RigData>;})
    ]).then(([gltf,data])=>{
      const model=gltf.scene;model.updateMatrixWorld(true);
      const convert=(p:number[])=>v(p[0],p[2],-p[1]);
      model.traverse(o=>{
        if(o instanceof THREE.Bone && data.bones[o.name]) {
          const d=data.bones[o.name];
          this.bindings.set(o.name,{bone:o,head:convert(d.head),direction:convert(d.tail).sub(convert(d.head)).normalize(),length:d.length,rotation:o.getWorldQuaternion(new THREE.Quaternion()),local:o.quaternion.clone(),localPosition:o.position.clone()});
        }
        if(o instanceof THREE.Mesh){
          o.castShadow=o.receiveShadow=true;o.frustumCulled=false;
          let firstPerson=false;
          for(let ancestor:THREE.Object3D|null=o;ancestor;ancestor=ancestor.parent)if(ancestor.name.startsWith('first_person_arms'))firstPerson=true;
          this.meshes.push({mesh:o,firstPerson});
        }
      });
      for(const name of ['pelvis','spine_01','spine_02','spine_03','neck_01','head','thigh_l','calf_l','foot_l','hand_l','upperarm_l','lowerarm_l','thigh_r','calf_r','foot_r','hand_r','upperarm_r','lowerarm_r'])if(!this.bindings.has(name))throw new Error(`missing rider bone ${name}`);
      this.model=model;this.group.add(model);this.fallback.group.visible=false;this.hardware.visible=true;
      this.update(this.pose);
    }).catch(error=>{this.error=String(error);console.error('Cyclist asset failed',error);});
  }
  stats(){return {ready:!!this.model,error:this.error,bones:this.bindings.size,reachExcess:this.reachExcess,source:this.model?'makehuman-cc0':'fallback'};}
  private setBone(name:string,position:THREE.Vector3,rotation:THREE.Quaternion){
    const b=this.bindings.get(name)!.bone;
    const worldPos=this.group.localToWorld(position.clone());
    const worldQ=this.group.getWorldQuaternion(new THREE.Quaternion()).multiply(rotation);
    b.parent!.updateWorldMatrix(true,false);
    b.position.copy(b.parent!.worldToLocal(worldPos));
    b.quaternion.copy(b.parent!.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(worldQ));b.updateWorldMatrix(false,true);
  }
  private aim(name:string,from:THREE.Vector3,to:THREE.Vector3){
    const bind=this.bindings.get(name)!;
    const q=new THREE.Quaternion().setFromUnitVectors(bind.direction,to.clone().sub(from).normalize()).multiply(bind.rotation);
    this.setBone(name,from,q);
  }
  update(pose:RiderPose){
    this.pose={...pose};
    if(!this.model){this.fallback.update(pose);return;}
    this.reachExcess=0;
    for(const [name,b] of this.bindings)if(/^(index|middle|ring|pinky|thumb)/.test(name)){b.bone.position.copy(b.localPosition);b.bone.quaternion.copy(b.local);}
    this.fallback.group.visible=false;
    for(const {mesh,firstPerson} of this.meshes)mesh.visible=firstPerson===pose.firstPerson;
    this.hardware.visible=true;
    const effort=pose.sprint,sway=Math.sin(pose.phase)*effort*.037;
    const hip=v(sway,1.005+effort*.05,-.24+effort*.10);
    const tilt=new THREE.Quaternion().setFromAxisAngle(v(1,0,0),pose.tuck?1.13:.88-effort*.06);
    const root=this.bindings.get('pelvis')!.head;
    const body=(p:THREE.Vector3)=>p.clone().sub(root).applyQuaternion(tilt).add(hip);
    for(const name of ['pelvis','spine_01','spine_02','spine_03']){
      const b=this.bindings.get(name)!;this.setBone(name,body(b.head),tilt.clone().multiply(b.rotation));
    }
    const neck=this.bindings.get('neck_01')!;
    const neckQ=new THREE.Quaternion().setFromAxisAngle(v(1,0,0),.45);
    const neckPos=body(neck.head);
    this.setBone('neck_01',neckPos,neckQ.clone().multiply(neck.rotation));
    const head=this.bindings.get('head')!;
    const headPos=head.head.clone().sub(neck.head).applyQuaternion(neckQ).add(neckPos);
    this.setBone('head',headPos,new THREE.Quaternion().setFromAxisAngle(v(1,0,0),.10).multiply(head.rotation));
    for(const {side,crank,pedal} of this.cranks){
      const suffix=side>0?'l':'r',angle=pose.phase+(side<0?Math.PI:0);
      const foot=v(side*.13,.32+Math.sin(angle)*.17,Math.cos(angle)*.17);
      const ankle=foot.clone().add(v(0,.042,-.075));
      const thigh=this.bindings.get('thigh_'+suffix)!,calf=this.bindings.get('calf_'+suffix)!;
      const hipJoint=thigh.head.clone().sub(root).add(hip);
      this.reachExcess=Math.max(this.reachExcess,hipJoint.distanceTo(ankle)-thigh.length-calf.length);
      const knee=joint(hipJoint,ankle,thigh.length,calf.length,v(side*.09,0,1));
      this.aim('thigh_'+suffix,hipJoint,knee);this.aim('calf_'+suffix,knee,ankle);
      this.setBone('foot_'+suffix,ankle,this.bindings.get('foot_'+suffix)!.rotation);
      const clavicle=this.bindings.get('clavicle_'+suffix)!;
      this.setBone('clavicle_'+suffix,body(clavicle.head),tilt.clone().multiply(clavicle.rotation));
      const arm=this.bindings.get('upperarm_'+suffix)!,forearm=this.bindings.get('lowerarm_'+suffix)!;
      const shoulder=body(arm.head);
      const hand=v(side*.245,.985,.57).sub(v(0,.87,.38)).applyAxisAngle(v(0,1,0),-pose.steeringAngle).add(v(0,.87,.38));
      const wrist=hand.clone().add(v(0,.025,-.055));
      this.reachExcess=Math.max(this.reachExcess,shoulder.distanceTo(wrist)-arm.length-forearm.length);
      const elbow=joint(shoulder,wrist,arm.length,forearm.length,v(side,-.15,-.55));
      this.aim('upperarm_'+suffix,shoulder,elbow);this.aim('lowerarm_'+suffix,elbow,wrist);
      this.aim('hand_'+suffix,wrist,hand.clone().add(v(0,0,.03)));
      for(const finger of ['index','middle','ring','pinky'])for(const segment of ['01','02','03']){
        const b=this.bindings.get(`${finger}_${segment}_${suffix}`)!;
        b.bone.updateWorldMatrix(true,false);
        const from=this.group.worldToLocal(b.bone.getWorldPosition(new THREE.Vector3()));
        const a=Number(segment)*.65;
        this.aim(`${finger}_${segment}_${suffix}`,from,from.clone().add(v(0,-Math.sin(a),Math.cos(a))));
      }
      connect(crank,v(side*.08,.32,0),foot,.013);pedal.position.copy(foot).add(v(0,-.028,0));
    }
    this.model.updateMatrixWorld(true);
  }
}
