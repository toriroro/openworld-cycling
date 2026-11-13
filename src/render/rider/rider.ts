// downhill-3D の src/render/ から移した（2026-11-13）。元は1行が長いので、ここで手を入れる時に読みやすく整える。
import * as THREE from 'three';
import { bone, connect, joint, shape, v } from "./models.ts";

export interface RiderPose { phase: number; sprint: number; tuck: boolean; steeringAngle: number; firstPerson: boolean }
export class RiderModel {
  group = new THREE.Group();
  private upper = new THREE.Group();
  private torso = shape(this.upper, '#b95436', [0, 1.29, -.03], [.2, .55, .14]);
  private shorts = shape(this.group, '#182937', [0, 1.03, -.21], [.18, .13, .16]);
  private head = new THREE.Group();
  private limbs = [-1, 1].map(side => ({ side, thigh: bone(this.group, '#182937'), shin: bone(this.group, '#c58d69'), upperArm: bone(this.group, '#b95436'), forearm: bone(this.group, '#c58d69'), knee:shape(this.group,'#c58d69',[0,0,0],[.061,.065,.061]), elbow:shape(this.group,'#c58d69',[0,0,0],[.039,.045,.039]), sock:bone(this.group,'#e7e5df'), shoe: shape(this.group, '#e7e5df', [0, 0, 0], [.06, .045, .125]), hand: shape(this.group, '#182937', [0, 0, 0], [.042, .035, .055]), pedal: shape(this.group, '#333f44', [0, 0, 0], [.10, .016, .075], false), crank: bone(this.group, '#aab7b9') }));
  constructor() {
    this.group.name = 'road-cyclist'; this.group.add(this.upper); this.upper.add(this.head);
    // A tapered jersey with shoulder breadth, waist and integrated rear pockets.
    this.torso.geometry = new THREE.LatheGeometry([[-.5,.68],[-.44,.75],[-.2,.78],[.08,.92],[.32,1],[.43,.85],[.5,.52]].map(([y,r])=>new THREE.Vector2(r,y)),24);
    for(const x of [-.52,0,.52]) shape(this.torso,'#a24631',[x,-.26,-.75],[.46,.30,.20],false);
    shape(this.torso,'#d9d3c5',[0,.23,-.92],[1.65,.08,.06],false);
    shape(this.torso,'#27383d',[0,-.47,0],[1.38,.065,1.15],false);
    shape(this.head, '#c58d69', [0, -.015, 0], [.092, .126, .1]);
    shape(this.head, '#e5e1d7', [0, .075, -.01], [.135, .10, .17]);
    for (const x of [-.085, -.04, 0, .04, .085]) shape(this.head, '#263138', [x, .15, .005], [.012, .012, .10]);
    for(const side of [-1,1]) {
      shape(this.head,'#c58d69',[side*.09,-.01,0],[.023,.04,.023]);
      const strap=bone(this.head,'#343a3b');connect(strap,v(side*.105,.02,-.03),v(side*.075,-.12,.065),.004);
    }
    shape(this.head, '#213b42', [0, .025, .1], [.12, .035, .04]);
    shape(this.head, '#d6a47e', [0, -.005, .13], [.025, .045, .033]);
    this.update({ phase: 0, sprint: 0, tuck: false, steeringAngle: 0, firstPerson: false });
  }
  update(pose: RiderPose) {
    const effort = pose.sprint, sway = Math.sin(pose.phase) * effort * .065;
    const hip = v(sway, 1.035 + effort * (.055 - Math.abs(Math.sin(pose.phase)) * .025), -.23 + effort * .16);
    const shoulder = v(sway * 1.6, 1.44 - (pose.tuck ? .14 : 0) + effort * .025, .16 + effort * .08);
    this.shorts.position.copy(hip);
    this.torso.position.copy(hip).add(shoulder).multiplyScalar(.5);
    this.torso.quaternion.setFromUnitVectors(v(0, 1, 0), shoulder.clone().sub(hip).normalize());
    this.torso.scale.y = hip.distanceTo(shoulder) * 1.05;
    this.head.position.copy(shoulder).add(v(0, pose.tuck ? .13 : .19, .045));
    this.head.rotation.x = -.1 - (pose.tuck ? .18 : 0);
    this.upper.visible = !pose.firstPerson;
    for (const l of this.limbs) {
      const angle = pose.phase + (l.side < 0 ? Math.PI : 0);
      const foot = v(l.side * .13, .32 + Math.sin(angle) * .17, Math.cos(angle) * .17);
      const hipJoint = hip.clone().add(v(l.side * .115, 0, 0));
      const knee = joint(hipJoint, foot, .48, .48, v(l.side * .1, 0, 1));
      connect(l.thigh, hipJoint, knee, .075); connect(l.shin, knee, foot, .042);
      l.knee.position.copy(knee);l.elbow.visible=!pose.firstPerson;
      connect(l.sock,foot.clone().lerp(knee,.23),foot,.044);
      l.shoe.position.copy(foot).add(v(0, .025, .045)); l.pedal.position.copy(foot).add(v(0, -.028, 0));
      connect(l.crank, v(l.side * .08, .32, 0), foot, .013);
      const hand = v(l.side * .245, .985, .57).sub(v(0, .87, .38)).applyAxisAngle(v(0, 1, 0), -pose.steeringAngle).add(v(0, .87, .38));
      const arm = shoulder.clone().add(v(l.side * .19, 0, 0));
      const elbow = joint(arm, hand, .29, .3, v(l.side, -.3, -.5));
      l.elbow.position.copy(elbow);
      connect(l.upperArm, arm, elbow, .05);
      // First-person forearms enter from below the camera instead of exposing cut shoulders.
      connect(l.forearm, pose.firstPerson ? v(l.side * .34, .83, -.4) : elbow, hand, .035); l.hand.position.copy(hand);
      l.upperArm.visible = !pose.firstPerson;
    }
  }
}
