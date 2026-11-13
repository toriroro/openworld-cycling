// downhill-3D の src/render/ から移した（2026-11-13）。元は1行が長いので、ここで手を入れる時に読みやすく整える。
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

/** Metre-scale road bike. +Z forward; steering and wheel pivots stay independent. */
export class RoadBikeModel {
  group = new THREE.Group();
  steering = new THREE.Group();
  wheels: THREE.Group[] = [];
  private previousDistance = 0;
  private rotation = 0;
  private display?: CanvasRenderingContext2D;
  private displayTexture?: THREE.CanvasTexture;
  private displaySpeed = -1;
  readonly computerScreen = new THREE.Mesh();
  constructor() {
    const paint = new THREE.MeshStandardMaterial({ color: '#bc512f', metalness: .48, roughness: .28 });
    const carbon = new THREE.MeshStandardMaterial({ color: '#172126', roughness: .38, metalness: .25 });
    const rubber = new THREE.MeshStandardMaterial({ color: '#171b1d', roughness: .94 });
    const alloy = new THREE.MeshStandardMaterial({ color: '#9ca9ae', metalness: .8, roughness: .32 });
    const tan = new THREE.MeshStandardMaterial({ color: '#827154', roughness: .85 });
    this.group.name = 'road-bike-v4'; this.steering.position.set(0, .87, .38); this.group.add(this.steering);
    const mesh = (geometry: THREE.BufferGeometry, material: THREE.Material, p: number[], parent: THREE.Object3D = this.group) => {
      const m = new THREE.Mesh(geometry, material); m.position.set(p[0],p[1],p[2]); m.castShadow = true; parent.add(m); return m;
    };
    const tube = (a: number[], b: number[], radius: number, material: THREE.Material = paint, parent: THREE.Object3D = this.group) => {
      const from = new THREE.Vector3(...a as [number,number,number]), to = new THREE.Vector3(...b as [number,number,number]);
      const m = mesh(new THREE.CylinderGeometry(radius*.8,radius,from.distanceTo(to),10),material,from.clone().add(to).multiplyScalar(.5).toArray(),parent);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),to.sub(from).normalize()); return m;
    };
    for (const z of [-.52,.52]) {
      const wheel = new THREE.Group(); wheel.position.set(0,.35,z);
      if(z>0) { wheel.position.sub(this.steering.position); this.steering.add(wheel); } else this.group.add(wheel);
      this.wheels.push(wheel);
      const torus = (r:number,t:number,m:THREE.Material) => { const ring=mesh(new THREE.TorusGeometry(r,t,6,48),m,[0,0,0],wheel); ring.rotation.y=Math.PI/2; };
      torus(.332,.016,rubber); torus(.32,.012,tan); torus(.299,.017,carbon);
      tube([-.048,0,0],[.048,0,0],.024,alloy,wheel);
      for(let i=0;i<20;i++) {const t=i*Math.PI/10; tube([(i%2?.025:-.025),0,0],[0,Math.sin(t)*.293,Math.cos(t)*.293],.0013,alloy,wheel);}
      const disc=mesh(new THREE.RingGeometry(.03,.072,24),alloy,[-.046,0,0],wheel); disc.rotation.y=-Math.PI/2; disc.material.side=THREE.DoubleSide;
    }
    tube([0,.32,0],[0,.89,-.23],.028);
    tube([0,.83,-.22],[0,.87,.38],.024);
    tube([0,.32,0],[0,.81,.4],.035);
    tube([0,.81,.4],[0,.93,.36],.027);
    tube([0,.87,-.23],[0,1,-.27],.018,carbon);
    for(const side of [-1,1]) {
      tube([side*.045,.32,0],[side*.058,.35,-.52],.012);
      tube([0,.82,-.21],[side*.058,.35,-.52],.011);
      tube([side*.023,-.06,.015],[side*.052,-.52,.14],.017,paint,this.steering);
      const points=[[side*.08,.32,0],[side*.08,.35,-.52],[side*.08,.31,-.53],[side*.08,.225,0],[side*.08,.32,0]].map(p=>new THREE.Vector3(...p as [number,number,number]));
      const chain = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),new THREE.LineBasicMaterial({color:'#999c97'})); this.group.add(chain);
      const barPoints = [[side*.02,.12,.1],[side*.21,.13,.1],[side*.25,.115,.19],[side*.26,.015,.25],[side*.26,-.04,.13]].map(p=>new THREE.Vector3(...p as [number,number,number]));
      mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(barPoints),24,.015,8,false),rubber,[0,0,0],this.steering);
      mesh(new THREE.CapsuleGeometry(.019,.07,4,8),carbon,[side*.245,.075,.18],this.steering).rotation.x=-.3;
      tube([side*.249,.07,.21],[side*.249,-.015,.22],.005,alloy,this.steering);
    }
    tube([0,0,0],[0,.13,.1],.019,carbon,this.steering);
    const saddle=mesh(new RoundedBoxGeometry(.145,.047,.265,3,.025),carbon,[0,1.0,-.255]); saddle.rotation.x=.04;
    mesh(new THREE.CylinderGeometry(.062,.062,.018,32),alloy,[.066,.32,0]).rotation.z=Math.PI/2;
    for(let i=0;i<5;i++) mesh(new THREE.CylinderGeometry(.025+i*.007,.025+i*.007,.005,24),alloy,[.048+i*.006,.35,-.52]).rotation.z=Math.PI/2;
    tube([.08,.35,-.52],[.08,.23,-.48],.011,carbon);
    const bottle=mesh(new THREE.CylinderGeometry(.035,.03,.16,12),new THREE.MeshStandardMaterial({color:'#c9cbc3',roughness:.5}),[0,.51,-.06]); bottle.rotation.x=-.35;
    mesh(new THREE.CylinderGeometry(.018,.018,.024,12),carbon,[0,.595,-.03]);
    mesh(new RoundedBoxGeometry(.066,.021,.102,2,.008),carbon,[0,.152,.16],this.steering);
    let displayMaterial:THREE.Material=new THREE.MeshBasicMaterial({color:'#c8d5af'});
    if(typeof document!=='undefined') {
      const canvas=document.createElement('canvas');canvas.width=256;canvas.height=384;
      this.display=canvas.getContext('2d')??undefined;
      this.displayTexture=new THREE.CanvasTexture(canvas);this.displayTexture.colorSpace=THREE.SRGBColorSpace;
      this.displayTexture.minFilter=THREE.LinearFilter;this.displayTexture.generateMipmaps=false;
      displayMaterial=new THREE.MeshBasicMaterial({map:this.displayTexture,toneMapped:false});
    }
    this.computerScreen.geometry=new THREE.PlaneGeometry(.049,.061);this.computerScreen.material=displayMaterial;
    this.computerScreen.name='cycle-computer-screen';this.computerScreen.position.set(0,.164,.16);
    this.computerScreen.rotation.set(-Math.PI/2,0,Math.PI);this.steering.add(this.computerScreen);this.updateSpeed(0);
    this.group.traverse(o=>{if(o instanceof THREE.Mesh) o.receiveShadow=true;});
  }
  private updateSpeed(speed:number) {
    const kph=Math.max(0,Math.round(speed*3.6));if(kph===this.displaySpeed)return;this.displaySpeed=kph;
    const c=this.display;if(!c)return;
    c.fillStyle='#c8d5af';c.fillRect(0,0,256,384);c.fillStyle='#17281e';c.textAlign='center';c.textBaseline='middle';
    c.font=`700 ${kph<100?174:132}px Arial, sans-serif`;c.fillText(String(kph),128,162);
    c.font='700 45px Arial, sans-serif';c.fillText('km/h',128,292);
    this.displayTexture!.needsUpdate=true;
  }
  computerStats(camera?:THREE.Camera){return {speedKph:this.displaySpeed,screen:this.computerScreen.getWorldPosition(new THREE.Vector3()).toArray(),corners:camera?[[-.0245,-.0305],[.0245,-.0305],[.0245,.0305],[-.0245,.0305]].map(([x,y])=>this.computerScreen.localToWorld(new THREE.Vector3(x,y,0)).project(camera).toArray()):[]};}
  update(distance:number, steering:number, speed=0) {
    this.updateSpeed(speed);
    const delta=distance-this.previousDistance;
    if(Math.abs(delta)<5) this.rotation+=delta/.335; else this.rotation=0;
    this.previousDistance=distance;
    for(const wheel of this.wheels) wheel.rotation.x=this.rotation;
    this.steering.rotation.y=-steering;
  }
}
