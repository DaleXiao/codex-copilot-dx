(() => {
  "use strict";
  // One fixed camera and one set of 3D joint coordinates for the entire assembly.
  const tau = 2 * Math.PI, diagonal = Math.SQRT1_2;
  const camera = [.5,.5,diagonal];
  const X = [1,0,0], Y = [0,1,0], Z = [0,0,1];
  const add = (a,b) => [a[0]+b[0],a[1]+b[1],a[2]+b[2]];
  const sub = (a,b) => [a[0]-b[0],a[1]-b[1],a[2]-b[2]];
  const scale = (a,k) => [a[0]*k,a[1]*k,a[2]*k];
  const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const len = a => Math.hypot(...a);
  const unit = a => scale(a,1/len(a));
  const mix = (a,b,s) => add(a,scale(sub(b,a),s));
  const clamp = (x,lo,hi) => Math.min(hi,Math.max(lo,x));
  const project = ([x,y,z]) => [(x-y)*diagonal,(x+y)/2-z*diagonal];
  const radial = (u,v,angle) => add(scale(u,Math.cos(angle)),scale(v,Math.sin(angle)));
  const withZ = ([x,y],z) => [x,y,z];

  const fixtureA = [89,-42], fixtureB = [86,40], park = [64,-4,79];
  const floor = 6, gripZ = 35, travelZ = 76;
  const upperLength = 62, foreLength = 53, closedGap = 7.4, openGap = 10.8;
  const transferStart = 3.85, transferEnd = 5.55, duration = 9.25;
  const queue = [];

  function progress(t) {
    // Integrate a piecewise linear speed profile. The outer quarters have constant acceleration.
    const r = .25, speed = 1/(1-r);
    if (t <= r) return speed*t*t/(2*r);
    if (t >= 1-r) return 1-speed*(1-t)*(1-t)/(2*r);
    return speed*(t-r/2);
  }

  function makeStages(a, b, yOffset) {
    const approach = [a[0]-5,a[1]+yOffset,61];
    return [
      [0,park,openGap], [.40,park,openGap], [1.50,approach,openGap], [2.00,withZ(a,61),openGap],
      [2.80,withZ(a,gripZ),openGap], [3.15,withZ(a,gripZ),closedGap], [3.35,withZ(a,gripZ),closedGap],
      [transferStart,withZ(a,travelZ),closedGap], [transferEnd,withZ(b,travelZ),closedGap],
      [6.45,withZ(b,gripZ),closedGap], [6.72,withZ(b,gripZ),closedGap], [7.09,withZ(b,gripZ),openGap],
      [7.82,withZ(b,61),openGap], [duration,park,openGap],
    ];
  }
  const stagesForward = makeStages(fixtureA, fixtureB, 4);
  const stagesReverse = makeStages(fixtureB, fixtureA, -4);
  function trajectory(t, reverse) {
    const stages = reverse ? stagesReverse : stagesForward;
    const i = stages.findIndex((stage, j) => j+1 === stages.length-1 || t < stages[j+1][0]);
    const [from, p, g] = stages[i], [to, q, h] = stages[i+1];
    const s = progress(clamp((t-from)/(to-from),0,1));
    return { position:mix(p,q,s), jaw:g+(h-g)*s,
      a:reverse?fixtureB:fixtureA, b:reverse?fixtureA:fixtureB };
  }

  function solve([x,y,z]) {
    const yaw = Math.atan2(y,x);
    const radialAxis = [Math.cos(yaw),Math.sin(yaw),0];
    const side = [-Math.sin(yaw),Math.cos(yaw),0];
    const reach = Math.hypot(x,y), shoulder = [0,0,50], lift = z-shoulder[2];
    const bend = -Math.acos(clamp((reach*reach+lift*lift-upperLength**2-foreLength**2)/(2*upperLength*foreLength),-1,1));
    const pitch = Math.atan2(lift,reach)-Math.atan2(foreLength*Math.sin(bend),upperLength+foreLength*Math.cos(bend));
    const planeVector = angle => add(scale(radialAxis,Math.cos(angle)),scale(Z,Math.sin(angle)));
    const upper = planeVector(pitch), fore = planeVector(pitch+bend);
    const elbow = add(shoulder,scale(upper,upperLength));
    return {yaw,bend,radialAxis,side,shoulder,elbow,wrist:add(elbow,scale(fore,foreLength)),upper,fore};
  }

  function face(points,fill,stroke=null,width=.43,bias=0) {
    const depth = points.reduce((sum,p)=>sum+dot(p,camera),0)/points.length;
    queue.push({points,fill,stroke,width,depth:depth+bias});
  }
  function line(a,b,stroke="fine",width=.46,bias=.15) {face([a,b],null,stroke,width,bias);}
  function ring(at,u,v,r,n=24,phase=0) {
    return Array.from({length:n},(_,i)=>add(at,scale(radial(u,v,phase+tau*i/n),r)));
  }
  function disk(at,u,v,r,fill="metal",stroke="edge",bias=.2) {face(ring(at,u,v,r),fill,stroke,.55,bias);}
  function visible(normal) {return dot(normal,camera) > .005;}
  function body(a,b,r,options={}) {
    const axis=unit(sub(b,a));
    const guide=options.guide ?? (Math.abs(dot(axis,Z))>.95 ? X : Z);
    const u=unit(cross(guide,axis)),v=cross(axis,u);
    const n=options.sectors ?? 24, start=ring(a,u,v,r,n), end=ring(b,u,v,r,n);
    for(let i=0;i<n;i++) {
      const j=(i+1)%n, normal=radial(u,v,tau*(i+.5)/n);
      if(!visible(normal))continue;
      const endI=end[i], endJ=end[j];
      const shade=clamp(Math.round((dot(normal,[-.42,-.49,.76])+1)*3),0,6);
      face([start[i],start[j],endJ,endI],options.color??"shade"+shade,
        null,.43);
      line(start[i],start[j],"edge",.42,.12);
      line(endI,endJ,"edge",.42,.12);
      if(!visible(radial(u,v,tau*(i-.5)/n)))line(start[i],endI,"edge",.62,.12);
      if(!visible(radial(u,v,tau*(i+1.5)/n)))line(start[j],endJ,"edge",.62,.12);
    }
    if(visible(axis))disk(b,u,v,r,options.cap??"metal");
    else disk(a,u,v,r,options.cap??"metal");
  }
  function slab(corners,z0,z1,offset=[0,0,0],top="metal") {
    const layer=z=>corners.map(([x,y])=>add([x,y,z],offset));
    const lower=layer(z0),upper=layer(z1);
    for(let i=0;i<corners.length;i++) {
      const j=(i+1)%corners.length;
      if(visible(cross(sub(lower[j],lower[i]),Z)))face([lower[i],lower[j],upper[j],upper[i]],"dark-metal","edge",.58);
    }
    face(upper,top,"edge",.68);
  }
  const rect=(x0,y0,x1,y1)=>[[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
  function bolt(at,u,v,r=1.35) {
    face(ring(at,u,v,r,6,Math.PI/6),"dark-metal","edge",.39,.4);
    line(add(at,scale(u,-r*.55)),add(at,scale(u,r*.55)),"recess",.36,.55);
  }
  function gear(at,u,v,r,n,angle) {
    const points=Array.from({length:n*4},(_,i)=>{
      const distance=i%4===0||i%4===3?r-.9:r+.55;
      return add(at,scale(radial(u,v,angle+tau*i/(n*4)),distance));
    });
    face(points,"dark-metal","edge",.50,.36);
    disk(add(at,scale(unit(cross(u,v)),.12)),u,v,r-2.5,"metal","edge",.56);
    disk(at,u,v,r*.24,"recess","edge",.8);
    for(let i=0;i<3;i++) {
      const spoke=radial(u,v,angle+i*tau/3);
      line(add(at,scale(spoke,r*.33)),add(at,scale(spoke,r*.72)),"edge",.58,.85);
    }
    const notch=radial(u,v,angle);
    line(add(at,scale(notch,r*.70)),add(at,scale(notch,r*.93)),"recess",.85,.94);
  }

  const platePath = [[-46,-63],[104,-63],[115,-52],[115,53],[104,64],[-46,64],[-56,54],[-56,-53]];
  function fixtureMark(at) {
    slab(rect(-12,-10,12,10),4.8,6,withZ(at,0),"paper");
    const center=withZ(at,6.12);
    for(const s of [-1,1]) {
      for(const q of [-1,1])bolt(add(center,[s*9,q*7,0]),X,Y,1.05);
      line(add(center,[s*7,-5,0]),add(center,[s*7,5,0]),"fine",.43,.2);
    }
    line(add(center,[0,-4,0]),add(center,[0,4,0]),"fine",.4,.2);
    line(add(center,[-4,0,0]),add(center,[4,0,0]),"fine",.4,.2);
  }
  function staticPlate() {
    slab(platePath,0,2,[0,0,0],"dark-metal");
    slab(platePath.map(([x,y])=>[x*.99,y*.983]),2,5);
    for(const [x,y] of [[-43,-51],[102,-51],[102,52],[-43,52]]) {
      disk([x,y,5.08],X,Y,3.8,"paper","fine");
      bolt([x,y,5.19],X,Y,2);
    }
    for(const at of [fixtureA,fixtureB])fixtureMark(at);
    const motor=[-27,19,5];
    slab(rect(-11,-9,11,9),0,4,motor,"dark-metal");
    for(let i=-3;i<=3;i++)line(add(motor,[i*2.6,-6,4.1]),add(motor,[i*2.6,6,4.1]),"edge",.55,.2);
    for(const shift of [0,3]) {
      line([-15,21+shift,5.4],[-8,21+shift,5.4],"edge",.75);
      line([-8,21+shift,5.4],[-5,16+shift,5.4],"edge",.75);
    }
  }
  function part(at) {
    const oct=[[-6,-4],[6,-4],[6,4],[4,6],[-4,6],[-6,4]];
    slab(oct,0,5,at,"paper");
    disk(add(at,[0,0,5.15]),X,Y,2.4,"recess","edge",.45);
    for(const x of [-4,4])bolt(add(at,[x,0,5.25]),X,Y,.95);
  }
  function scanner(at, locked) {
    const base=withZ(at,6.4);
    const stroke=locked?"sensor":"fine";
    for(const s of [-1,1])for(const q of [-1,1]){
      line(add(base,[s*11,q*5,0]),add(base,[s*11,q*9,0]),stroke,.85,.25);
      line(add(base,[s*11,q*9,0]),add(base,[s*7,q*9,0]),stroke,.85,.25);
    }
  }
  function piston(anchor,pin,side) {
    const d=sub(pin,anchor), axis=unit(d);
    const barrel=add(anchor,scale(axis,16));
    body(add(anchor,scale(axis,1)),barrel,2.25,{guide:side,sectors:12});
    body(add(barrel,scale(axis,-1.7)),pin,1.04,{guide:side,sectors:12,color:"paper"});
    body(add(barrel,scale(axis,-1.1)),barrel,2.52,{guide:side,sectors:14,color:"dark-metal"});
    for(const joint of [anchor,pin])body(add(joint,scale(side,-1.8)),add(joint,scale(side,1.8)),2.05,{sectors:12});
  }
  function ringBolts(at,u,v,r,count=6) {
    for(const p of ring(at,u,v,r,count,Math.PI/6))bolt(p,u,v,1.08);
  }

  function actuatorTube(a,b,side,r) {
    const axis=unit(sub(b,a)), extent=len(sub(b,a)), at=d=>add(a,scale(axis,d));
    body(at(0),at(extent),r,{guide:side});
    for(const d of [1.2,extent-3.3])body(at(d),at(d+2.1),r+1.12,{guide:side,color:"dark-metal"});
    for(const d of [5,7.2,extent-6.8,extent-4.8])body(at(d),at(d+.48),r+.54,{guide:side,color:"edge",sectors:24});
    const normal=unit(cross(side,axis));
    for(const angle of [0,2.1,4.2]) {
      const outward=radial(side,normal,angle);
      if(!visible(outward))continue;
      const tangent=unit(cross(outward,axis));
      const surface=add(at(extent*.54),scale(outward,r+.16));
      const patch=[[0,-2],[9,-2],[9,2],[0,2]].map(([x,y])=>add(surface,add(scale(axis,x-4.5),scale(tangent,y))));
      face(patch,"dark-metal","fine",.41,.4);
      for(const k of [-3,0,3]){
        const tick=add(surface,scale(axis,k));
        line(add(tick,scale(tangent,-1.1)),add(tick,scale(tangent,1.1)),"edge",.48,.65);
      }
    }
  }
  function joint(at,side,d,r,u,v) {
    body(add(at,scale(side,-d)),add(at,scale(side,d)),r,{guide:u,cap:"paper"});
    const near=add(at,scale(side,visible(side)?d+.15:-d-.15));
    disk(near,u,v,r*.85,"metal","edge",.35);
    ringBolts(near,u,v,r*.69);
    disk(near,u,v,r*.36,"recess","edge",.62);
    disk(near,u,v,r*.21,"paper","edge",.8);
  }
  function gripper(wrist,jaw,yaw) {
    const at=(x,y,z)=>add(wrist,[x,y,z]);
    body(wrist,at(0,0,-13),4.65,{cap:"paper"});
    body(at(0,0,-6),at(0,0,-11),6.2,{cap:"dark-metal"});
    const index=radial(X,Y,-yaw);
    line(add(at(0,0,-6),scale(index,4.8)),add(at(0,0,-6),scale(index,6.1)),"ink",.85,.55);
    slab(rect(-13,-3.8,13,3.8),-17,-13,wrist,"metal");
    for(const y of [-3,3])body(at(-12,y,-19),at(12,y,-19),.94,{sectors:10,color:"paper"});
    body(at(-12,4.1,-19),at(12,4.1,-19),1.0,{sectors:12,color:"dark-metal"});
    const screwAngle=tau*(openGap-jaw)/2.4;
    for(const sign of [-1,1]) {
      let prev=null;
      for(let j=0;j<=32;j++) {
        const k=j/4,a=screwAngle+tau*k/2.4;
        const n=[0,Math.cos(a),Math.sin(a)];
        const p=at(sign*k,4.1+1.15*n[1],-19+1.15*n[2]);
        if(prev&&visible(n))line(prev,p,"ink",.38,.21);
        prev=p;
      }
      const x=sign*jaw;
      slab(rect(x-1.6,-3.15,x+1.6,3.15),-22,-18,wrist,"dark-metal");
      slab(rect(x-1.3,-2.8,x+1.3,2.8),-28,-21,wrist,"metal");
      const pad=x-sign*1.35;
      slab(rect(pad-.1,-2.25,pad+.1,2.25),-27.4,-23.25,wrist,"recess");
      for(let i=0;i<3;i++)line(at(x-.8,2.9,-24-i),at(x+.8,2.9,-24-i),"fine",.4,.29);
    }
  }

  function drawArm(t, reverse) {
    const state=trajectory(t,reverse), pose=solve(state.position);
    const {wrist,shoulder,elbow,upper,fore,side,radialAxis,yaw,bend}=pose;
    const beforePickup=t<3.15, afterPlacement=t>=6.45;
    const cargo=beforePickup?withZ(state.a,floor):afterPlacement?withZ(state.b,floor):add(wrist,[0,0,floor-gripZ]);
    part(cargo);
    if(t>0&&t<3.35)scanner(state.a,t>=2);
    if(t>=5.55&&t<7.82)scanner(state.b,t>=6.45);

    body([0,0,5],[0,0,11],25,{color:"dark-metal",cap:"metal"});
    for(const p of ring([0,0,11.12],X,Y,21,8))bolt(p,X,Y,1.5);
    body([0,0,11],[0,0,18],19,{cap:"paper"});
    gear([0,0,18.16],X,Y,17.4,32,yaw);
    body([0,0,18],[0,0,23],14,{cap:"paper"});
    body([0,0,23],[0,0,43],10.6,{cap:"metal"});
    body([0,0,24],[0,0,27],11.2,{color:"dark-metal"});
    body([0,0,40],[0,0,44],11.75,{cap:"paper"});
    const baseNotch=add([0,0,44.2],scale(radialAxis,8));
    line(baseNotch,add(baseNotch,scale(radialAxis,3)),"ink",1.1,.38);
    for(const sign of [-1,1]) {
      const y=scale(side,sign*8.6);
      body(add([0,0,36],y),add(shoulder,y),3.7,{cap:"dark-metal",sectors:14});
    }

    actuatorTube(add(shoulder,scale(upper,7)),add(elbow,scale(upper,-6)),side,7);
    actuatorTube(add(elbow,scale(fore,6)),add(wrist,scale(fore,-5)),side,5.5);
    const sign=visible(side)?1:-1, outward=scale(side,sign);
    const lateral=scale(outward,13);
    const anchor=add(add(shoulder,scale(radialAxis,-1)),add(scale(Z,-14),lateral));
    const pin=add(add(shoulder,scale(upper,24)),lateral);
    piston(anchor,pin,side);
    const elbowAnchor=add(add(elbow,scale(upper,-21)),scale(outward,12));
    const elbowPin=add(add(elbow,scale(fore,11)),scale(outward,12));
    piston(elbowAnchor,elbowPin,side);

    const planeV=unit(cross(outward,upper));
    joint(shoulder,side,10,9,radialAxis,Z);
    joint(elbow,side,9.5,8,upper,planeV);
    joint(wrist,side,6,4.8,radialAxis,Z);

    // The pair is mounted on the upper-arm bracket. Both pitch circles meet on its centerline.
    const ringCenter=add(elbow,scale(outward,11.6));
    const pinionCenter=add(ringCenter,scale(upper,-16.2));
    const bracket=scale(outward,-2.4);
    body(add(pinionCenter,bracket),add(ringCenter,bracket),3.7,{guide:outward,color:"dark-metal",sectors:12});
    body(add(pinionCenter,scale(outward,-4)),pinionCenter,4.65,{guide:upper,color:"dark-metal"});
    const drivenAngle=-sign*bend;
    gear(ringCenter,upper,planeV,10.8,24,drivenAngle);
    gear(pinionCenter,upper,planeV,5.4,12,Math.PI/12-2*drivenAngle);
    gripper(wrist,state.jaw,yaw);
  }

  function palette(ink, paper) {
    const pixel = document.createElement("canvas");
    pixel.width=pixel.height=1;
    const sampler = pixel.getContext("2d", { willReadFrequently:true });
    const rgb = value => {
      sampler.fillStyle=value;
      sampler.fillRect(0,0,1,1);
      return Array.from(sampler.getImageData(0,0,1,1).data).slice(0,3);
    };
    const a=rgb(ink), b=rgb(paper);
    const tone = amount => "rgb("+b.map((c,i)=>Math.round(c+(a[i]-c)*amount)).join(",")+")";
    const colors={paper,ink,edge:tone(.82),fine:tone(.59),metal:tone(.11),
      "dark-metal":tone(.25),recess:tone(.44),sensor:ink};
    for(let i=0;i<7;i++) colors["shade"+i]=tone(.36-i*.048);
    return colors;
  }

  function paint(context,colors) {
    context.lineJoin="round";context.lineCap="round";
    queue.sort((a,b)=>a.depth-b.depth);
    for(const {points,fill,stroke,width} of queue) {
      context.beginPath();context.moveTo(...project(points[0]));
      for(let i=1;i<points.length;i++)context.lineTo(...project(points[i]));
      if(fill){context.closePath();context.fillStyle=colors[fill];context.fill();}
      if(stroke){context.strokeStyle=colors[stroke];context.lineWidth=width;context.stroke();}
    }
    queue.length=0;
  }

  globalThis.ccdxToolArm = context => {
    let key, platform, colors, zoom, left, top;
    return (_style,{time,width,height,dpr,ink,surface}) => {
      const next = [width,height,dpr,ink,surface].join("|");
      if (key !== next) {
        const w=context.canvas.width, h=context.canvas.height;
        colors=palette(ink,surface);
        zoom=Math.min((width-12)/254,(height-12)/180)*dpr;
        if (!(zoom>0)) return;
        left=w/2-21*zoom;top=h/2-5*zoom;
        platform=document.createElement("canvas");platform.width=w;platform.height=h;
        const base=platform.getContext("2d");
        base.setTransform(zoom,0,0,zoom,left,top);
        staticPlate();paint(base,colors);
        key=next;
      }
      context.setTransform(1,0,0,1,0,0);
      context.drawImage(platform,0,0);
      context.setTransform(zoom,0,0,zoom,left,top);
      const elapsed=Math.max(0,time);
      const cycle=Math.floor(elapsed/duration);
      drawArm(elapsed-cycle*duration,cycle%2===1);
      paint(context,colors);
    };
  };
})();
