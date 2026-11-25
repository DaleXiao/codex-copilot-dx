(() => {
  "use strict";
  const d=Math.SQRT1_2,tau=2*Math.PI,Z=[0,0,1],X=[1,0,0],Y=[0,1,0],camera=[.5,.5,d];
  const limit=(n,a,b)=>Math.max(a,Math.min(n,b));
  const mix=(a,b,t)=>a+(b-a)*t;
  const project=([x,y,z])=>[(x-y)*d,(x+y)*.5-z*d];
  const depth=([x,y,z])=>(x+y)*.5+z*d;
  const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const plus=(a,b)=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]];
  const scale=(a,s)=>a.map(n=>n*s);
  const identity=p=>p;
  function placement([x,y],angle,z=0) {
    const c=Math.cos(angle),s=Math.sin(angle);
    return ([u,v,w])=>[x+c*u-s*v,y+s*u+c*v,z+w];
  }
  const floor=4,palletBottom=13.2,lo=11.25,hi=18.6;
  const [aisleX,aisleY]=[162,112];
  const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
  const jobs=[
    {kind:"cartons",name:"纸箱托盘",home:[19,aisleY],from:[54,aisleY],stop:[108,aisleY],
      through:[[219,aisleY]],delivery:[[270,aisleY],[270,157]],park:[270,197],start:0,color:"amber"},
    {kind:"totes",name:"周转箱托盘",home:[aisleX,209],from:[aisleX,184],stop:[aisleX,163],
      through:[[aisleX,61]],delivery:[[81,61]],park:[34,61],start:.55,color:"sage"},
    {kind:"crate",name:"木箱托盘",home:[304,61],from:[270,61],stop:[216,61],
      through:[[aisleX,61],[aisleX,176]],delivery:[[64,176]],park:[24,176],start:1.1,color:"edge"},
  ];
  const direction=(a,b)=>Math.atan2(b[1]-a[1],b[0]-a[0]);
  function timedPath(initial,waypoints,start,speed) {
    const legs=[];
    let pose=initial,time=start;
    function addLeg(next,duration) {
      legs.push({from:pose,to:next,start:time,end:time+duration});
      time+=duration;pose=next;
    }
    for(const point of waypoints) {
      const length=distance(pose.point,point);
      if(!length)continue;
      const delta=direction(pose.point,point)-pose.heading;
      const turn=Math.atan2(Math.sin(delta),Math.cos(delta));
      if(Math.abs(turn)>1e-6)addLeg({...pose,heading:pose.heading+turn,rotation:pose.rotation+turn},.88*Math.abs(turn)/(Math.PI/2));
      addLeg({...pose,point,travel:pose.travel+length},.24+length/speed);
    }
    return {initial,legs,final:pose,end:time};
  }
  for(const j of jobs) {
    const parked={point:j.home,heading:direction(j.home,j.from),travel:0,rotation:0};
    j.pickup=timedPath(parked,[j.from],j.start,24);
    j.dock=j.pickup.end;
    j.liftEnd=j.dock+1.05;
    j.leave=j.liftEnd+.40;
    j.approach=timedPath(j.pickup.final,[j.stop],j.leave,27);
    j.waitSince=j.approach.end;
  }
  let available=0;
  for(const j of [...jobs].sort((a,b)=>a.waitSince-b.waitSince)) {
    j.entry=Math.max(j.waitSince,available);
    j.crossing=timedPath(j.approach.final,j.through,j.entry,37);
    j.exit=j.crossing.end;
    available=j.exit+.48;
    j.outbound=timedPath(j.crossing.final,j.delivery,j.exit,25);
    j.arrive=j.outbound.end;
    j.lowerEnd=j.arrive+1.10;
    j.release=j.lowerEnd+.32;
    j.depart=timedPath(j.outbound.final,[j.park],j.release,24);
    j.done=j.depart.end;
    j.route=[j.home,j.from,j.stop,...j.through,...j.delivery,j.park];
  }
  const total=Math.ceil((Math.max(...jobs.map(j=>j.done))+.4)*50)/50;
  let queue=[];

  function polygon(vertices, fill=null, edge=null, width=.46, bias=0) {
    queue.push({p:vertices,fill,edge,width,depth:vertices.reduce((n,v)=>n+depth(v),0)/vertices.length+bias});
  }
  function line(a,b,ink="fine",width=.45,bias=.2) {polygon([a,b],null,ink,width,bias);}
  const rect=(x,y,w,h)=>[[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
  function slab(points,z0,z1,top="steel",side="joint",tr=identity) {
    const a=points.map(([x,y])=>tr([x,y,z0])),b=points.map(([x,y])=>tr([x,y,z1]));
    for(let i=0;i<a.length;i++){
      const j=(i+1)%a.length,dx=a[j][0]-a[i][0],dy=a[j][1]-a[i][1];
      if(dy-dx>0)polygon([a[i],a[j],b[j],b[i]],side,"edge",.5);
    }
    polygon(b,top,"edge",.58);
  }
  function box(x,y,z,w,h,v,top="steel",side="joint",tr=identity) {
    slab(rect(x,y,w,h),z,z+v,top,side,tr);
  }
  function flat(x,y,z,w,h,color,tr=identity) {polygon(rect(x,y,w,h).map(([x,y])=>tr([x,y,z])),color,null);}
  function ring(origin,u,v,r,n=18,angle=0) {
    return Array.from({length:n},(_,i)=>plus(origin,plus(scale(u,r*Math.cos(angle+i*tau/n)),scale(v,r*Math.sin(angle+i*tau/n)))));
  }
  function disk(origin,u,v,r,fill="steel",ink="edge",bias=.2) {polygon(ring(origin,u,v,r),fill,ink,.43,bias);}
  function cylinder(a,b,u,v,r,fill="steel",n=16){
    const left=ring(a,u,v,r,n),right=ring(b,u,v,r,n);
    for(let i=0;i<n;i++){
      const j=(i+1)%n,angle=(i+.5)*tau/n;
      if(dot(plus(scale(u,Math.cos(angle)),scale(v,Math.sin(angle))),camera)>0)
        polygon([left[i],left[j],right[j],right[i]],i%3===0?"joint":fill,null);
    }
    const facing=depth(b)>depth(a);
    disk(facing?b:a,u,v,r,fill);
  }
  function bolt(x,y,z,r=1.1,tr=identity){
    polygon(ring([x,y,z],X,Y,r,6,Math.PI/6).map(tr),"joint","edge",.37,.4);
    line(tr([x-r*.55,y,z]),tr([x+r*.55,y,z]),"edge",.36,.51);
  }
  function stopLine(job,color="fine",width=.66){
    const tr=placement(job.stop,job.approach.final.heading);
    for(const across of [-14,-6,2,10])
      line(tr([16,across,4.23]),tr([16,across+4,4.23]),color,width);
  }
  function routeDashes(){
    const lanes=new Map();
    for(const job of jobs)for(let i=1;i<job.route.length;i++){
      const a=job.route[i-1],b=job.route[i],along=a[1]===b[1]?0:1;
      const fixed=a[1-along],key=along+":"+fixed;
      if(!lanes.has(key))lanes.set(key,{along,fixed,segments:[]});
      lanes.get(key).segments.push([Math.min(a[along],b[along]),Math.max(a[along],b[along])]);
    }
    for(const {along,fixed,segments} of lanes.values()){
      segments.sort((a,b)=>a[0]-b[0]);
      const joined=[];
      for(const span of segments){
        const previous=joined.at(-1);
        if(previous&&previous[1]>=span[0])previous[1]=Math.max(previous[1],span[1]);
        else joined.push(span.slice());
      }
      const point=n=>along?[fixed,n,4.13]:[n,fixed,4.13];
      for(const [begin,end] of joined){
        for(let n=Math.ceil(begin/10)*10;n+5<=end;n+=10)line(point(n),point(n+5),"fine",.58);
      }
    }
  }
  function platform() {
    const outline=[[7,0],[319,0],[326,7],[326,218],[319,225],[7,225],[0,218],[0,7]];
    slab(outline,0,floor,"floor","joint");
    routeDashes();
    for(const job of jobs)stopLine(job);
    for(const [x,y] of [[9,9],[316,9],[9,215],[316,215]])bolt(x,y,4.12,1.9);
  }
  function shippingBox(x,y,z,w,h,v,material,tr=identity){
    box(x,y,z,w,h,v,material==="crate"?"wood":"kraft",material==="crate"?"kraft":"wood",tr);
    flat(x+w*.43,y+.4,z+v+.08,w*.13,h-.8,"tape",tr);
    line(tr([x+w*.62,y+.5,z+v+.13]),tr([x+w*.62,y+h-.5,z+v+.13]),"fine",.32);
    const yFace=y+h+.07;
    polygon([[x+2.4,yFace,z+v-2.1],[x+8.5,yFace,z+v-2.1],[x+8.5,yFace,z+v-5.4],[x+2.4,yFace,z+v-5.4]].map(tr),"paper-label",null,.3,.22);
    for(let j=0;j<5;j++)line(tr([x+3+j*.93,yFace+.04,z+v-4.65]),tr([x+3+j*.93,yFace+.04,z+v-2.9]),"edge",.27,.24);
    if(material==="crate"){
      for(const r of [1.2,v-1.9]){
        line(tr([x+.5,yFace,z+r]),tr([x+w-.5,yFace,z+r]),"edge",.55,.28);
        line(tr([x+w+.09,y+.4,z+r]),tr([x+w+.09,y+h-.4,z+r]),"edge",.55,.28);
      }
      line(tr([x+1,yFace,z+1.5]),tr([x+w-1,yFace,z+v-1.8]),"fine",.75,.27);
    }
    if(w>12)line(tr([x+w-4,yFace,z+2.1]),tr([x+w-1.7,yFace,z+2.1]),"edge",.37,.3);
  }
  function tote(x,y,z,w,h,v,tr=identity) {
    box(x,y,z,w,h,v,"tote","steel",tr);
    box(x-.75,y-.75,z+v-1.5,w+1.5,h+1.5,1.8,"tote","steel",tr);
    for(let i=2.5;i<w-1;i+=3.4)
      line(tr([x+i,y+h+.08,z+1]),tr([x+i,y+h+.08,z+v-2.1]),"fine",.52,.25);
    for(let i=2.5;i<h-1;i+=3.4)
      line(tr([x+w+.08,y+i,z+1]),tr([x+w+.08,y+i,z+v-2.1]),"fine",.52,.25);
    line(tr([x+w*.36,y+h*.6,z+v+.36]),tr([x+w*.63,y+h*.6,z+v+.36]),"sage",.88,.3);
  }
  function rack(x,y,bays) {
    const gap=37,end=x+bays*gap;
    for(let i=0;i<=bays;i++){
      for(const dy of [0,24]){
        box(x+i*gap-2,y+dy-2,4,4.5,4.5,1.35,"steel","joint");
        box(x+i*gap,y+dy,5,2.4,2.4,49,"steel","joint");
        for(let z=12;z<51;z+=5)line([x+i*gap+.65,y+dy+2.5,z],[x+i*gap+1.7,y+dy+2.5,z],"edge",.37,.22);
      }
      const xx=x+i*gap+1.15;
      for(const [low,high] of [[7,28],[29,51]])
        line([xx,y+1.3,low],[xx,y+25.3,high],"belt",.96);
    }
    for(const z of [8,30,52]){
      for(const dy of [.8,24.2])box(x+2.1,y+dy,z,end-x,1.8,2.2,"steel","joint");
      if(z<52){
        for(let i=0;i<bays;i++)box(x+i*gap+2.1,y+2,z+.3,gap-1,22,1.7,"deck","belt");
      }
    }
    for(let i=0;i<bays;i++){
      const ax=x+i*gap+5;
      if(i%3!==1)shippingBox(ax,y+4,10,16,16,12+i%2*3,"cartons");
      if(i%4!==2)shippingBox(ax+17,y+6,10,12,14,9,"crate");
      if(i%3===0)tote(ax+5,y+6,32,22,15,9);
      else if(i%3===1)shippingBox(ax+4,y+6,32,22,15,13,"cartons");
      else {
        shippingBox(ax,y+4,32,13,14,10,"cartons");
        shippingBox(ax+16,y+6,32,13,14,12,"cartons");
      }
    }
  }
  function fixedScene(){
    rack(22,8,3);
    rack(185,8,3);
    for(const x of [15,308]){
      box(x,8,4,3,33,5,"joint","belt");
      box(x-.8,37,4,4.7,4.7,10,"steel","joint");
    }
  }
  function pallet(point,z,kind,heading) {
    const tr=placement(point,heading);
    const w=31,h=31,px=-w/2,py=-h/2;
    const feet=9.2;
    for(const xx of [1,w-5.6])for(const yy of [1,h-4.65])
      box(px+xx,py+yy,z-feet,4.55,3.6,feet,"wood","belt",tr);
    for(const yy of [0,7.45,14.9,22.35,29.8]){
      box(px,py+yy,z,w,Math.min(4.1,31-yy),2.45,"wood","belt",tr);
    }
    const base=z+2.46;
    if(kind==="cartons"){
      shippingBox(-12.9,-12,base,14,21.8,13,"cartons",tr);
      shippingBox(1.45,-11,base,11.4,21.9,10.1,"cartons",tr);
      shippingBox(-12,-10.6,base+13,11.2,19.4,9.6,"cartons",tr);
    }else if(kind==="totes"){
      tote(-12,-10.6,base,24,21.2,7.4,tr);
      tote(-12,-10.6,base+7.7,24,21.2,7.4,tr);
    }else {
      shippingBox(-13.1,-12.1,base,26.2,24.2,16,"crate",tr);
      const cap=base+16.11;
      for(const xx of [-9,8])
        flat(xx,-11.3,cap,2.6,22.6,"belt",tr);
      for(const xx of [-7.7,9.3])for(const yy of [-8,8])bolt(xx,yy,cap+.08,.76,tr);
    }
  }
  const footprint=[[-15,-6.8],[-12.3,-9],[12.3,-9],[15,-6.8],[15,6.8],[12.3,9],[-12.3,9],[-15,6.8]];
  function cart(job,state) {
    const z=state.deck,tr=placement(state.point,state.heading);
    const forward=[Math.cos(state.heading),Math.sin(state.heading),0], across=[-forward[1],forward[0],0];
    polygon(ring(tr([1,1.5,4.11]),X,Y,12,20),"shadow",null,.3,-.08);
    for(const dx of [-8.8,8.8])for(const side of [-1,1]){
      const center=tr([dx,side*9.2,7.2]);
      const a=plus(center,scale(across,-1.35)),b=plus(center,scale(across,1.35));
      cylinder(a,b,forward,Z,3.18,"heel",14);
      if(dot(across,camera)*side>0){
        const hub=plus(side===1?b:a,scale(across,side*.07));
        disk(hub,forward,Z,2.2,"steel");
        disk(plus(hub,scale(across,side*.04)),forward,Z,.92,"joint","edge",.36);
        const theta=-(state.travel-side*9.2*state.rotation)/3.18;
        for(let i=0;i<4;i++){
          const a=theta+i*tau/4,c=Math.cos(a),s=Math.sin(a);
          const v=plus(scale(forward,c),scale(Z,s));
          line(plus(hub,scale(v,1.03)),plus(hub,scale(v,1.99)),"edge",.42,.5);
        }
      }
    }
    slab(footprint,5.6,9.45,"steel","heel",tr);
    slab(footprint.map(([a,b])=>[a*.975,b*.98]),9.45,10.3,"deck","steel",tr);
    for (const direction of [-1,1]) {
      const a=direction*15;
      line(tr([a,-4.4,8.65]),tr([a,4.4,8.65]),"fine",.6);
      for(const yy of [-4.65,4.65])
        line(tr([direction*14.53,yy-.8,9.36]),tr([direction*14.53,yy+.8,9.36]),job.color,1.3,.35);
    }
    for(const side of [-1,1]){
      const yy=side*5.9;
      line(tr([-5.8,yy,10.5]),tr([5.8,yy,z-.47]),"edge",1.1,.32);
      line(tr([5.8,yy,10.5]),tr([-5.8,yy,z-.47]),"belt",.9,.32);
    }
    box(-9,-6.6,z-.82,18,13.2,.82,"steel","heel",tr);
    for(const a of [-5.8,5.8])line(tr([a,-5.1,z+.05]),tr([a,5.1,z+.05]),"edge",.46);
    for(const a of [-12.4,12.4]){
      disk(tr([a,-3.8,10.55]),X,Y,1.72,"heel","edge",.26);
      disk(tr([a,-3.8,11.05]),X,Y,.91,state.waiting?"amber":state.moving?job.color:"joint",null,.3);
    }
    for(const a of [-10.6,10.6])for(const b of [-6.6,6.6])bolt(a,b,10.43,.64,tr);
  }

  function trajectory(a,b,time,start,end){
    const u=limit((time-start)/(end-start),0,1);
    const q=.23, peak=1/(1-q);
    const s=u<q?peak*u*u/(2*q):u>1-q?1-peak*(1-u)**2/(2*q):peak*(u-q/2);
    return mix(a,b,s);
  }
  function poseAt(path,time){
    const leg=path.legs.find(leg=>time<leg.end);
    if(!leg)return path.final;
    const {from,to,start,end}=leg;
    const s=trajectory(0,1,time,start,end);
    return {
      point:[mix(from.point[0],to.point[0],s),mix(from.point[1],to.point[1],s)],
      heading:mix(from.heading,to.heading,s),travel:mix(from.travel,to.travel,s),rotation:mix(from.rotation,to.rotation,s),
    };
  }
  function stateAt(j,time){
    const path=time<j.leave?j.pickup:time<j.entry?j.approach:time<j.exit?j.crossing:time<j.release?j.outbound:j.depart;
    const pose=poseAt(path,time);
    const deck=time<=j.arrive?trajectory(lo,hi,time,j.dock+.26,j.liftEnd):trajectory(hi,lo,time,j.arrive+.21,j.lowerEnd);
    const carrying=time>=j.dock && time<j.lowerEnd;
    const cargo=carrying?pose:time>=j.lowerEnd?j.outbound.final:j.pickup.final;
    const cargoHeight=carrying?Math.max(palletBottom,deck):palletBottom;
    const waiting=time>=j.waitSince&&time<j.entry;
    const moving=(time>j.start&&time<j.dock)||(time>j.leave&&time<j.arrive&&!waiting)||(time>j.release&&time<j.done);
    return {...pose,deck,cargo,cargoHeight,moving,waiting};
  }
  function paint(context,items,colors,sort=true){
    context.lineJoin="round";context.lineCap="round";
    if(sort)items.sort((a,b)=>a.depth-b.depth);
    for(const item of items){
      context.beginPath();context.moveTo(...project(item.p[0]));
      for(let i=1;i<item.p.length;i++)context.lineTo(...project(item.p[i]));
      if(item.fill){context.closePath();context.fillStyle=colors[item.fill];context.fill();}
      if(item.edge){context.strokeStyle=colors[item.edge];context.lineWidth=item.width;context.stroke();}
    }
  }
  function palette(ink,surface){
    const pixel=document.createElement("canvas");pixel.width=pixel.height=1;
    const sampler=pixel.getContext("2d",{willReadFrequently:true});
    const rgb=value=>{
      sampler.fillStyle=value;sampler.fillRect(0,0,1,1);
      return Array.from(sampler.getImageData(0,0,1,1).data).slice(0,3);
    };
    const a=rgb(ink),p=rgb(surface);
    const tone=s=>"rgb("+p.map((c,i)=>Math.round(mix(c,a[i],s))).join(",")+")";
    return {ink,edge:tone(.82),fine:tone(.64),floor:tone(.09),joint:tone(.23),shadow:tone(.16),
      deck:tone(.12),steel:tone(.19),heel:tone(.51),kraft:tone(.21),wood:tone(.30),tote:tone(.34),
      tape:tone(.08),sage:ink,amber:tone(.75),"paper-label":surface,belt:tone(.4)};
  }

  fixedScene();const fixtures=queue;queue=[];
  globalThis.ccdxToolWarehouse = context => {
    let key,colors,ground,zoom,left,top;
    return (_style,{time,width,height,dpr,ink,surface}) => {
      const size=Math.min((width-10)/402,(height-8)/320)*dpr;
      if(!(size>0))return;
      const next=[width,height,dpr,ink,surface].join("|");
      if(next!==key){
        colors=palette(ink,surface);zoom=size;
        left=context.canvas.width/2-35*zoom;top=context.canvas.height/2-123*zoom;
        ground=document.createElement("canvas");
        ground.width=context.canvas.width;ground.height=context.canvas.height;
        const base=ground.getContext("2d");
        base.setTransform(zoom,0,0,zoom,left,top);platform();paint(base,queue,colors,false);
        queue=[];key=next;
      }
      const elapsed=Math.max(0,time);
      const cycle=Math.floor(elapsed/total),phase=elapsed-cycle*total;
      // The next cycle returns the loads along the same collision-tested trajectories.
      const moment=cycle%2?total-phase:phase;
      context.setTransform(1,0,0,1,0,0);context.drawImage(ground,0,0);
      context.setTransform(zoom,0,0,zoom,left,top);
      for(const job of jobs){
        const state=stateAt(job,moment);
        if(state.waiting)stopLine(job,"amber",1.18);
        cart(job,state);pallet(state.cargo.point,state.cargoHeight,job.kind,state.cargo.heading);
      }
      paint(context,fixtures.concat(queue),colors);queue=[];
    };
  };
})();
