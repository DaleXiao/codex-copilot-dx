(() => {
  "use strict";
  const palette = (inkColor, paperColor) => {
    const sampler = document.createElement("canvas");sampler.width=1;sampler.height=1;
    const sample = sampler.getContext("2d",{willReadFrequently:true});
    const rgb = value => {
      sample.clearRect(0,0,1,1);sample.fillStyle=value;sample.fillRect(0,0,1,1);
      return [...sample.getImageData(0,0,1,1).data.slice(0,3)];
    };
    const ink = rgb(inkColor), paper = rgb(paperColor), colors = new Map();
    const tone = strength => {
      if (!colors.has(strength)) colors.set(strength, "rgb(" + paper.map((x,i) => Math.round(mix(x,ink[i],strength))).join(",") + ")");
      return colors.get(strength);
    };
    return { paper: paperColor, ink: inkColor, line: tone(.79), soft: tone(.58), metal: tone(.08),
      side: tone(.17), flank: tone(.27), recess: tone(.37), shadow: tone(.07) };
  };
  const diagonal = Math.SQRT1_2;
  const tau = Math.PI * 2;
  const wrap = (value, period) => ((value % period) + period) % period;
  const mix = (a, b, amount) => a + (b - a) * amount;
  function segment(value, start, end) {
    const t = Math.min(1, Math.max(0, (value - start) / (end - start)));
    return t * t * (3 - 2 * t);
  }
  const project = ([x, y, z]) => [(x - y) * diagonal, (x + y) / 2 - z * diagonal];

  function renderer(context, width, height, colors, kind) {
    const scale = Math.min(width / (kind === "clock" ? 208 : 305), height / (kind === "clock" ? 161 : kind === "rotary" ? 190 : 218));
    const ox = width / 2 + (kind === "rotary" ? 3 : kind === "clock" ? -3 : -5) * scale;
    const oy = height / 2 + (kind === "rotary" ? 20 : kind === "clock" ? 17 : 7) * scale;
    context.clearRect(0, 0, width, height);
    context.lineJoin = "round";
    context.lineCap = "round";
    context.save();
    context.translate(ox, oy);
    context.scale(scale, scale);

    function shape(vertices, fill, stroke = "line", weight = 0.62) {
      const points = vertices.map(project);
      context.beginPath();
      context.moveTo(...points[0]);
      for (const point of points.slice(1)) context.lineTo(...point);
      if (fill) {
        context.closePath();
        context.fillStyle = colors[fill];
        context.fill();
      }
      if (stroke) {
        context.strokeStyle = colors[stroke];
        context.lineWidth = weight;
        context.stroke();
      }
    }

    function line(from, to, stroke = "line", weight = 0.46) {
      shape([from, to], null, stroke, weight);
    }

    function box(x, y, z, w, d, h, top = "paper", front = "side", end = "metal") {
      const a = [x, y, z + h], b = [x + w, y, z + h];
      const c = [x + w, y + d, z + h], e = [x, y + d, z + h];
      shape([b, [x + w, y, z], [x + w, y + d, z], c], end);
      shape([e, c, [x + w, y + d, z], [x, y + d, z]], front);
      shape([a, b, c, e], top);
    }

    function plane(x, y, z, turn, draw) {
      context.save();
      const point = project([x, y, z]);
      context.transform(diagonal, 0.5, -diagonal, 0.5, ...point);
      context.rotate(turn);
      draw(context);
      context.restore();
    }

    function outline(path, fill, stroke = "line", weight = 0.54) {
      if (fill) {
        context.fillStyle = colors[fill];
        context.fill(path, "evenodd");
      }
      if (stroke) {
        context.strokeStyle = colors[stroke];
        context.lineWidth = weight;
        context.stroke(path);
      }
    }

    function circle(x, y, z, radius, fill, stroke = "line", weight = 0.49) {
      plane(x, y, z, 0, () => {
        const path = new Path2D();
        path.arc(0, 0, radius, 0, tau);
        outline(path, fill, stroke, weight);
      });
    }

    function hole(x, y, z, radius = 1.15) {
      circle(x, y, z, radius, "flank", "soft", 0.37);
      line([x - radius * 0.57, y, z], [x + radius * 0.57, y, z], "soft", 0.35);
    }

    function flange(x, y, z, radius, height, bore = 0, top = "paper") {
      const start = -Math.PI / 4;
      const arc = Array.from({ length: 16 }, (_, i) => {
        const a = start + Math.PI * i / 15;
        return [x + radius * Math.cos(a), y + radius * Math.sin(a)];
      });
      shape([...arc.map(([px, py]) => [px, py, z]), ...arc.reverse().map(([px, py]) => [px, py, z + height])], "side");
      circle(x, y, z + height, radius, top);
      if (bore) {
        circle(x, y, z + height, bore, "recess");
        circle(x, y, z + height, bore + 1.3, null, "soft", 0.39);
      }
    }

    function shaftCap(x, y, z, radius, phase, fill = "metal") {
      const point = project([x, y, z]);
      context.save();
      context.transform(diagonal, 0.5, 0, -diagonal, ...point);
      const face = new Path2D();
      face.arc(0, 0, radius, 0, tau);
      outline(face, fill);
      const hub = new Path2D();
      hub.arc(0, 0, radius * 0.34, 0, tau);
      outline(hub, "flank", "line", 0.4);
      const slot = new Path2D();
      slot.moveTo(Math.cos(phase) * radius * 0.42, Math.sin(phase) * radius * 0.42);
      slot.lineTo(Math.cos(phase) * radius * 0.82, Math.sin(phase) * radius * 0.82);
      outline(slot, null, "ink", 0.62);
      context.restore();
    }

    return { context, colors, shape, line, box, plane, outline, circle, hole, flange, shaftCap };
  }

  const beltHeight = 34.7;
  const station = -12;
  const palletHeight = beltHeight + 2.6;
  const pitch = 42;

  function platform(r, x, y, w, d) {
    r.shape([[x + 3, y + 5, 0], [x + w + 5, y + 5, 0],
      [x + w + 5, y + d + 6, 0], [x + 3, y + d + 6, 0]], "shadow", null);
    r.box(x, y, 1, w, d, 3, "metal", "flank");
    for (const dx of [6, w - 6]) for (const dy of [5, d - 5]) r.hole(x + dx, y + dy, 4.05);
  }

  function trackSupport(r, x, y, width) {
    for (const edge of [y - width + 3, y + width - 7]) {
      r.box(x - 4, edge - 2, 4, 13, 9, 2, "metal");
      r.hole(x - 1.9, edge + 4.9, 6.03);
      r.hole(x + 6.8, edge + 4.9, 6.03);
      r.box(x, edge, 6, 5, 5, 19, "metal");
      r.line([x + 2.5, edge + 5, 8], [x + 2.5, edge + 5, 24], "soft");
    }
    r.box(x - 1, y - width + 2, 23, 7, width * 2 - 4, 3, "metal");
  }

  function cover(r, x, y, width, length) {
    const z = beltHeight;
    r.box(x, y - width - 3, z - 2, length, 3, 15, "metal");
    r.box(x, y + width, z - 3, length, 3, 16, "metal");
    r.box(x, y - width - 3, z + 13, length, 2 * width + 6, 2.5, "paper");
    for (const dx of [2.7, length - 2.7]) for (const dy of [-width, width]) r.hole(x + dx, y + dy, z + 15.53);
    for (let dx = length / 2 - 4; dx < length / 2 + 6; dx += 2) {
      r.line([x + dx, y - 4, z + 15.54], [x + dx, y + 4, z + 15.54], "soft", 0.6);
    }
  }

  function belt(r, left, right, y, width, travel, payload = () => {}) {
    const drum = 5.7, axle = 29, straight = right - left;
    const round = Math.PI * drum, loop = 2 * (straight + round);
    const count = Math.ceil(loop / 8);
    const z = beltHeight;
    r.box(left - 4, y - width - 3, 24, straight + 8, 3, 10, "metal");
    r.box(left, y - width, axle - drum, straight, width * 2, 2, "metal", "flank");
    const band = Array.from({ length: 13 }, (_, index) => {
      const a = Math.PI * index / 12;
      return [right + drum * Math.sin(a), y + width, axle + drum * Math.cos(a)];
    });
    r.shape([...band, ...band.slice().reverse().map(([x, , zz]) => [x, y - width, zz])], "flank");
    r.shape([[left, y - width, z], [right, y - width, z], [right, y + width, z], [left, y + width, z]], "metal");
    for (let i = 0; i < count; i++) {
      const s = wrap(i * loop / count + travel, loop);
      if (s >= straight + round) continue;
      const a = (s - straight) / drum;
      const x = s < straight ? left + s : right + drum * Math.sin(a);
      const zz = s < straight ? z : axle + drum * Math.cos(a);
      r.line([x, y - width + 1.3, zz], [x, y + width - 1.3, zz], "soft");
    }
    payload();
    r.box(left - 4, y + width, 24, straight + 8, 3, 9.8, "paper", "side");
    r.line([left + 7, y + width + 3.02, 26.3], [right - 7, y + width + 3.02, 26.3], "soft", 0.51);
    r.shaftCap(left, y + width + 3.25, axle, 3.6, -travel / drum);
    r.shaftCap(right, y + width + 3.25, axle, 4.1, -travel / drum);
  }

  function pallet(r, x, y, width = 12) {
    r.box(x - 6.3, y - width / 2, beltHeight, 12.6, width, 2.6, "paper");
  }

  function workpiece(r, x, y, z, seated = false) {
    r.flange(x, y, z, 5, 1.4, 0, "metal");
    r.flange(x, y, z + 1.4, 3.9, 4.4, seated ? 1.3 : 2.65, seated ? "metal" : "paper");
    if (seated) r.circle(x, y, z + 5.84, 2.45, null, "soft", 0.35);
  }

  function motor(r, x, y) {
    r.box(x - 9, y - 1, 18, 19, 10, 2, "metal");
    r.box(x - 7, y, 20, 15, 10, 12, "metal", "flank");
    for (let dx = -5; dx <= 6; dx += 2.4) {
      r.line([x + dx, y + 3, 32.04], [x + dx, y + 10, 32.04], "soft", 0.6);
      r.line([x + dx, y + 10.03, 32], [x + dx, y + 10.03, 21.5], "soft", 0.6);
    }
  }

  function indexCycle(distance) {
    const time = (distance + 0.16) / 2.12;
    const step = Math.floor(time), phase = time - step;
    const advance = pitch * segment(phase, 0, 0.26);
    return { step, phase, advance, travel: pitch * step + advance };
  }

  function transferPose(phase, from, to) {
    const low = palletHeight, high = low + 19;
    const lift = segment(phase, 0.27, 0.38) - segment(phase, 0.43, 0.55)
      + segment(phase, 0.69, 0.79) - segment(phase, 0.85, 0.93);
    const side = segment(phase, 0.55, 0.69) - segment(phase, 0.93, 1);
    const grip = segment(phase, 0.38, 0.43) - segment(phase, 0.79, 0.85);
    const y = mix(from, to, side);
    const z = mix(high, low, lift);
    if (phase < 0.43) return { y, z, grip, part: [from, low] };
    if (phase < 0.79) return { y, z, grip, part: [y, z] };
    return { y, z, grip, part: [to, low] };
  }

  function jaw(r, x, y, z, grip) {
    const gap = mix(5.9, 3.9, grip);
    r.box(x - 4.8, y - 4.8, z + 6.2, 9.6, 9.6, 5, "metal");
    for (const side of [-1, 1]) {
      const edge = x + side * gap;
      r.box(edge - (side < 0 ? 1.7 : 0), y - 2.3, z + 2.3, 1.7, 4.6, 5.6, "flank");
      r.box(edge - (side < 0 ? 2 : 0), y - 2.3, z + 2.1, 2, 4.6, 1.5, "side");
    }
    r.hole(x, y, z + 11.26, 1.25);
  }

  function armLink(r, a, b, height, half) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const length = Math.hypot(dx, dy), nx = -dy * half / length, ny = dx * half / length;
    const edge = (point, sign, z) => [point[0] + nx * sign, point[1] + ny * sign, z];
    const front = nx + ny > 0 ? 1 : -1;
    r.shape([edge(a, front, height), edge(b, front, height),
      edge(b, front, height - 4.7), edge(a, front, height - 4.7)], "side");
    r.shape([edge(a, -1, height), edge(b, -1, height), edge(b, 1, height), edge(a, 1, height)], "paper");
    r.line([a[0], a[1], height + 0.02], [b[0], b[1], height + 0.02], "soft", 0.51);
  }

  function scaraHead(r, shoulder, x, pose) {
    const wrist = [x, pose.y];
    const dx = wrist[0] - shoulder[0], dy = wrist[1] - shoulder[1];
    const link = 30, reach = Math.hypot(dx, dy);
    const lift = Math.sqrt(link * link - reach * reach / 4);
    const elbow = [shoulder[0] + dx / 2 - dy * lift / reach, shoulder[1] + dy / 2 + dx * lift / reach];
    jaw(r, x, pose.y, pose.z, pose.grip);
    r.flange(x, pose.y, pose.z + 11.2, 1.7, 70 - pose.z - 11.2, 0, "metal");
    armLink(r, elbow, wrist, 73, 4.6);
    r.flange(x, pose.y, 70, 4.5, 5, 1.45, "metal");
    armLink(r, shoulder, elbow, 78, 5.4);
    r.flange(...elbow, 72.2, 5.3, 7.2, 1.7, "metal");
    r.flange(...shoulder, 74, 6.5, 6, 2, "metal");
  }

  function press(r, x, y, phase, partTop, top = 73) {
    const stroke = segment(phase, 0.31, 0.52) - segment(phase, 0.65, 0.83);
    const tip = mix(partTop + 18, partTop, stroke);
    r.flange(x, y, tip, 2.4, top - tip, 0, "side");
    r.box(x - 5.4, y - 4.7, top - 6, 10.8, 9.4, 10, "metal");
    r.hole(x, y, top + 4.04, 1.2);
  }

  function singleLine(r, distance, robotic) {
    const cycle = indexCycle(distance);
    const width = robotic ? 19 : 13;
    const shoulder = [-26, -40];
    const pose = transferPose(cycle.phase, -8.5, 8.5);
    const top = robotic ? 80 : 77;

    r.layer("bed", r => {
      platform(r, -121, robotic ? -50 : -40, 242, robotic ? 79 : 65);
      if (robotic) {
        r.box(-36, -48, 4, 20, 17, 3, "paper");
        for (const x of [-33, -19]) for (const y of [-45, -34]) r.hole(x, y, 7.04);
        r.flange(...shoulder, 7, 6.9, 5, 0, "metal");
        r.flange(...shoulder, 12, 4.6, 65, 0, "metal");
        r.flange(...shoulder, 59, 6.25, 11.5, 0, "side");
      } else {
        r.box(station - 10, -37, 4, 20, 14, 3);
        r.hole(station - 7, -33, 7.02);
        r.hole(station + 7, -33, 7.02);
        r.box(station - 6, -35, 7, 12, 9, top - 10, "metal");
        r.line([station - 3, -25.95, 10], [station - 3, -25.95, top - 5], "soft");
      }
      for (const x of [-83, -37, 31, 82]) trackSupport(r, x, 0, width);
    });
    belt(r, -108, 109, 0, width, cycle.travel, () => {
      for (let i = 0; i < 5; i++) {
        const x = -102 + wrap(i * pitch + 6 + cycle.travel, 5 * pitch);
        const indexed = cycle.phase >= 0.26;
        const atStation = indexed && Math.abs(x - station) < 0.1;
        const processed = indexed ? x > station + 0.1 : x >= station + cycle.advance - 0.1;
        pallet(r, x, 0, robotic ? 29 : 12);
        if (robotic) {
          for (const y of [-8.5, 8.5]) r.circle(x, y, palletHeight + 0.03, 5, null, "soft", 0.41);
          const [y, z] = atStation ? pose.part : [processed ? 8.5 : -8.5, palletHeight];
          workpiece(r, x, y, z);
        } else {
          workpiece(r, x, 0, palletHeight, processed || (atStation && cycle.phase >= 0.52));
        }
      }
    });
    r.layer("guards", r => {
      cover(r, -113, 0, width, 24);
      cover(r, 90, 0, width, 25);
      motor(r, 107, width + 5);
    });
    if (robotic) {
      scaraHead(r, shoulder, station, pose);
    } else {
      r.box(station - 6, -35, top - 6, 12, 41, 6, "paper");
      r.line([station - 2.8, -31, top + 0.03], [station - 2.8, 2.7, top + 0.03], "soft");
      for (const y of [-31, 2.4]) r.hole(station + 2.8, y, top + 0.04, 1.1);
      press(r, station, 0, cycle.phase, palletHeight + 5.8, top - 8);
    }
  }

  function sortPose(distance) {
    const time = (distance + 0.13) / 1.86;
    const step = Math.floor(time), phase = time - step;
    const lane = step % 2 ? 23 : -23;
    const y = lane * (segment(phase, 0.34, 0.55) - segment(phase, 0.74, 0.94));
    const x = -104 + 78 * segment(phase, 0.04, 0.34) + 128 * segment(phase, 0.55, 0.94);
    return { x, y, lane, step, phase, incoming: 78 * segment(phase, 0.04, 0.34) };
  }

  function sorter(r, distance) {
    const { x, y, lane, phase, step, incoming } = sortPose(distance);
    const partY = phase <= 0.55 ? y : lane;
    const max = 102;
    platform(r, -119, -44, 234, 88);
    for (const sx of [-85, -52]) trackSupport(r, sx, 0, 11);
    for (const cy of [-23, 23]) for (const sx of [11, 57, 91]) trackSupport(r, sx, cy, 10);

    for (const sx of [-35, -17]) {
      r.box(sx - 2.5, -36, 4, 8, 72, 15, "metal", "side");
      r.box(sx, -36, 19, 3, 72, 5, "paper");
      for (const edge of [-34, 31]) r.hole(sx + 1.5, edge, 24.02, 0.8);
    }
    belt(r, -107, -45, 0, 11, step * 78 + incoming, () => {
      if (x <= -39) {
        pallet(r, x, 0);
        workpiece(r, x, 0, palletHeight);
      }
    });
    r.box(-37, y - 10.7, 24, 20, 21.4, 9.5, "paper", "side");
    const shuttleTravel = step * 89 + incoming + Math.max(0, Math.min(11, x + 26));
    belt(r, -33, -21, y, 9, shuttleTravel, () => {
      if (x > -39 && x <= -15) {
        pallet(r, x, partY);
        workpiece(r, x, partY, palletHeight);
      }
    });
    for (const cy of [-23, 23]) {
      const completed = Math.floor((step + (cy < 0 ? 1 : 0)) / 2);
      const outgoing = cy === lane ? Math.max(0, x + 15) : 0;
      belt(r, -9, 107, cy, 10, completed * 117 + outgoing, () => {
        if (x > -15 && x < max + 0.1 && cy === lane) {
          pallet(r, x, cy);
          workpiece(r, x, cy, palletHeight);
        }
      });
      cover(r, 90, cy, 10, 22);
    }
    cover(r, -113, 0, 11, 21);
  }

  function gantry(r, distance) {
    const cycle = indexCycle(distance);
    const far = -23, near = 23;
    const pose = transferPose(cycle.phase, far, near);
    const z = 79;
    platform(r, -118, -51, 233, 103);
    function column(y) {
      r.box(station - 10, y - 7, 4, 20, 14, 3);
      for (const x of [station - 7, station + 7]) r.hole(x, y + 3.7, 7.03);
      r.box(station - 5.6, y - 4, 7, 11.2, 8, z - 10, "metal");
      r.line([station - 2.4, y + 4.03, 10], [station - 2.4, y + 4.03, z - 5], "soft");
    }
    column(-44);
    for (const y of [far, near]) {
      for (const x of [-86, -41, 21, 75]) trackSupport(r, x, y, 10);
      belt(r, -108, 108, y, 10, cycle.travel, () => {
        for (let i = 0; i < 5; i++) {
          const x = -102 + wrap(i * pitch + 6 + cycle.travel, 5 * pitch);
          const indexed = cycle.phase >= 0.26;
          const atStation = indexed && Math.abs(x - station) < 0.1;
          const processed = indexed ? x > station + 0.1 : x >= station + cycle.advance - 0.1;
          pallet(r, x, y);
          if (!atStation && (processed ? near : far) === y) workpiece(r, x, y, palletHeight);
        }
      });
      cover(r, -113, y, 10, 21);
      cover(r, 90, y, 10, 21);
    }
    if (cycle.phase >= 0.26) workpiece(r, station, ...pose.part);
    jaw(r, station, pose.y, pose.z, pose.grip);
    r.flange(station, pose.y, pose.z + 11.2, 1.9, z - pose.z - 11.2, 0, "metal");
    column(44);
    r.box(station - 6.7, -49, z - 6, 13.4, 98, 6, "paper", "side");
    for (const x of [station - 4.2, station + 4.2]) {
      r.line([x, -45, z + 0.04], [x, 45, z + 0.04], "soft", 0.65);
      for (const y of [-45, 45]) r.hole(x, y, z + 0.05, 0.8);
    }
    r.box(station - 7.4, pose.y - 5.4, z - 7.3, 14.8, 10.8, 9.4, "metal");
    r.hole(station, pose.y, z + 2.13, 1.6);
    r.box(station - 6, 43, z, 12, 8, 4.4, "flank");
  }

  function rotary(r, distance) {
    const { step, phase, advance } = indexCycle(distance);
    const slot = tau / 6, rotation = (step + advance / pitch) * slot;
    const bearing = 26, radius = 47, top = 29.8;
    const angle = -Math.PI / 3, orbit = 34;
    const axis = [Math.cos(angle) * orbit, Math.sin(angle) * orbit];
    r.layer("table", r => {
      platform(r, -57, -62, 114, 116);
      r.box(11, -59, 4, 20, 13, 3, "paper");
      for (const x of [14, 28]) r.hole(x, -54, 7.04);
      r.box(15, -57, 7, 12, 9, 67, "metal");
      r.line([18, -47.97, 10], [18, -47.97, 71], "soft");
      r.flange(0, 0, 4, bearing + 7, 4, 0, "metal");
      r.flange(0, 0, 8, bearing, 15.8, 0, "side");
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 4 + Math.PI * i / 9;
        const x = bearing * Math.cos(a), y = bearing * Math.sin(a);
        r.line([x, y, 8.7], [x, y, 22.9], "soft", 0.61);
      }
      r.flange(0, 0, 23.8, radius, 6, 0, "metal");
    });
    r.circle(0, 0, top + 0.01, 44, null, "soft", 0.6);
    const fixtures = [];
    for (let i = 0; i < 6; i++) {
      const a = angle + i * slot + rotation;
      fixtures.push({ x: Math.cos(a) * orbit, y: Math.sin(a) * orbit, i });
      const mark = a + slot / 2;
      const direction = [Math.cos(mark), Math.sin(mark)];
      r.line([...direction.map(v => v * 42), top + 0.02], [...direction.map(v => v * 46), top + 0.02], "soft", 0.7);
    }
    r.flange(0, 0, top, 10, 3.1, 2.4, "paper");
    for (const { x, y, i } of fixtures.sort((a, b) => a.x + a.y - b.x - b.y)) {
      const arrival = (6 - i) % 6;
      const seated = step + (phase >= 0.52 ? 1 : 0) > ((arrival + 5) % 6);
      r.flange(x, y, top, 7.8, 2.5, 0, "paper");
      workpiece(r, x, y, top + 2.5, seated);
    }
    r.box(15, -57, 72, 12, 34, 5, "paper");
    for (const y of [-53, -26]) r.hole(21, y, 77.04, 1.25);
    press(r, ...axis, phase, top + 8.3, 67);
  }

  const pressureAngle = Math.PI / 9;
  const involute = angle => Math.tan(angle) - angle;
  function makeWheel(teeth, windows, bore, moduleSize) {
    const pitchRadius = moduleSize * teeth / 2;
    const outerRadius = pitchRadius + moduleSize;
    const rootRadius = pitchRadius - 1.25 * moduleSize;
    const base = pitchRadius * Math.cos(pressureAngle);
    const rootFlank = Math.max(base, rootRadius);
    const step = tau / teeth;
    const halfTooth = step * 0.245;
    const halfAngle = (radius) => halfTooth + involute(pressureAngle) - involute(Math.acos(base / radius));
    const path = new Path2D();
    function point(radius, angle, move = false) {
      const x = radius * Math.cos(angle), y = radius * Math.sin(angle);
      const method = move ? "moveTo" : "lineTo";
      path[method](x, y);
    }
    for (let i = 0; i < teeth; i++) {
      const angle = i * step;
      point(rootRadius, angle - step / 2, i === 0);
      point(rootRadius, angle - halfAngle(rootFlank) - step * 0.055);
      for (let j = 0; j <= 4; j++) {
        const radius = rootFlank + (outerRadius - rootFlank) * j / 4;
        point(radius, angle - halfAngle(radius));
      }
      for (let j = 4; j >= 0; j--) {
        const radius = rootFlank + (outerRadius - rootFlank) * j / 4;
        point(radius, angle + halfAngle(radius));
      }
      point(rootRadius, angle + halfAngle(rootFlank) + step * 0.055);
      point(rootRadius, angle + step / 2);
    }
    path.closePath();
    const outerWindow = rootRadius - 3.2;
    const innerWindow = bore + 2.8;
    for (let i = 0; i < windows; i++) {
      const middle = i * tau / windows;
      const half = Math.PI / windows - 0.15;
      const from = middle - half, to = middle + half;
      path.moveTo(outerWindow * Math.cos(from), outerWindow * Math.sin(from));
      path.arc(0, 0, outerWindow, from, to);
      path.lineTo(innerWindow * Math.cos(to - 0.17), innerWindow * Math.sin(to - 0.17));
      path.arc(0, 0, innerWindow, to - 0.17, from + 0.17, true);
      path.closePath();
    }
    return { teeth, pitchRadius, rootRadius, path, bore };
  }

  function polar(radius, angle) {
    return [radius * Math.cos(angle), radius * Math.sin(angle)];
  }

  function offset([x, y], radius, angle) {
    const [dx, dy] = polar(radius, angle);
    return [x + dx, y + dy];
  }

  const minuteAxis = [-54, -27];
  const minuteWheel = makeWheel(72, 6, 5.5, 0.75);
  const minutePinion = makeWheel(12, 0, 3.2, 1);
  const barrelWheel = makeWheel(58, 0, 4, 1);
  const barrelOpening = 24;
  barrelWheel.path.moveTo(barrelOpening, 0);
  barrelWheel.path.arc(0, 0, barrelOpening, 0, tau);
  barrelWheel.path.closePath();
  const barrelMesh = -1.46;
  const barrelAxis = offset(minuteAxis, barrelWheel.pitchRadius + minutePinion.pitchRadius, barrelMesh + Math.PI);

  const thirdPinion = makeWheel(12, 0, 2.5, 0.75);
  const thirdWheel = makeWheel(80, 5, 4.1, 0.67);
  const thirdMesh = 0.12;
  const thirdAxis = offset(minuteAxis, minuteWheel.pitchRadius + thirdPinion.pitchRadius, thirdMesh);

  const secondsPinion = makeWheel(8, 0, 1.7, 0.67);
  const secondsWheel = makeWheel(60, 5, 3.5, 0.60);
  const secondsMesh = 0.45;
  const secondsAxis = offset(thirdAxis, thirdWheel.pitchRadius + secondsPinion.pitchRadius, secondsMesh);

  const escapePinion = makeWheel(10, 0, 1.8, 0.60);
  const escapeMesh = -0.57;
  const escapeAxis = offset(secondsAxis, secondsWheel.pitchRadius + escapePinion.pitchRadius, escapeMesh);
  const leverAxis = -0.38;
  const palletSpan = 22.5;
  const balanceSpan = 46.5;
  const balanceCenter = offset(escapeAxis, balanceSpan, leverAxis);
  const palletCenter = offset(escapeAxis, palletSpan, leverAxis);
  const escapeTeeth = 15;
  const toothPitch = tau / escapeTeeth;
  const toothTip = 15.2;
  const lockAngle = 3.5 * toothPitch / 2;
  const banking = 0.116;

  const escapeWheel = new Path2D();
  const clubTooth = [[10.7, -0.49], [10.7, -0.30], [13.65, 0.025], [toothTip, 0],
    [15.05, 0.16], [13.85, 0.24], [10.7, 0.32]];
  for (let i = 0; i < escapeTeeth; i++) {
    for (const [j, [radius, fraction]] of clubTooth.entries()) {
      const point = polar(radius, (i + fraction) * toothPitch);
      if (i === 0 && j === 0) escapeWheel.moveTo(...point);
      else escapeWheel.lineTo(...point);
    }
  }
  escapeWheel.closePath();
  for (let i = 0; i < 5; i++) {
    const start = i * tau / 5 + 0.13, end = start + tau / 5 - 0.26;
    escapeWheel.moveTo(...polar(8.95, start));
    escapeWheel.arc(0, 0, 8.95, start, end);
    escapeWheel.lineTo(...polar(3.6, end - 0.17));
    escapeWheel.arc(0, 0, 3.6, end - 0.17, start + 0.17, true);
    escapeWheel.closePath();
  }

  // External mesh phases, solved backwards from the intermittent escape-wheel motion.
  function drivingAngle(wheel, pinion, driven, axis) {
    const alignment = (wheel.teeth + pinion.teeth) * axis + pinion.teeth * Math.PI - Math.PI;
    return (alignment - driven * pinion.teeth) / wheel.teeth;
  }

  function clockPose(distance) {
    const time = distance * 5.6;
    const beat = Math.floor(time);
    const phase = time - beat;
    const direction = beat % 2 === 0 ? 1 : -1;
    const advance = (beat + segment(phase, 0.50, 0.70)) * toothPitch / 2;
    const escape = leverAxis + lockAngle - advance;
    const seconds = drivingAngle(secondsWheel, escapePinion, escape, escapeMesh);
    const third = drivingAngle(thirdWheel, secondsPinion, seconds, secondsMesh);
    const minute = drivingAngle(minuteWheel, thirdPinion, third, thirdMesh);
    const barrel = drivingAngle(barrelWheel, minutePinion, minute, barrelMesh);
    return {
      escape, seconds, third, minute, barrel,
      pallet: direction * banking * (1 - 2 * segment(phase, 0.42, 0.61)),
      balance: -1.78 * Math.cos(Math.PI * time)
    };
  }

  const initialClock = clockPose(0);

  function gearFace(r, axis, height, gear, angle, finish = "paper") {
    const { path, bore, rootRadius } = gear;
    for (const z of [height - 1.8, height - 0.9]) {
      r.plane(...axis, z, angle, () => r.outline(path, "flank", null));
    }
    r.plane(...axis, height, angle, () => r.outline(path, finish));
    if (rootRadius - bore > 6) r.circle(...axis, height + 0.02, rootRadius - 1.27, null, "soft", 0.38);
    r.flange(...axis, height, bore, 1.25, 0, "side");
    r.circle(...axis, height + 1.27, bore * 0.5, "recess", "line", 0.44);
    r.line([...offset(axis, -bore * 0.39, angle), height + 1.31],
      [...offset(axis, bore * 0.39, angle), height + 1.31], "ink", 0.48);
  }

  function drawCoil(r, center, height, inner, outer, turns, wind, weight) {
    const path = new Path2D();
    const count = Math.ceil(turns * 29);
    for (let i = 0; i <= count; i++) {
      const fraction = i / count;
      const point = polar(mix(inner, outer, fraction), tau * turns * fraction + wind * (1 - fraction));
      if (i === 0) path.moveTo(...point);
      else path.lineTo(...point);
    }
    r.plane(...center, height, 0, () => r.outline(path, null, "line", weight));
  }

  function clockBridge(r, from, bearing, height, width, pillar = 2.9) {
    r.flange(...from, 5, pillar, height - 9.65, 0, "metal");
    armLink(r, from, bearing, height, width);
    r.hole(...from, height + 0.04, width - 0.75);
    r.flange(...bearing, height - 0.8, width + 0.95, 1.35, 0, "metal");
    r.circle(...bearing, height + 0.57, width * 0.54, "recess", "ink", 0.55);
    r.circle(...bearing, height + 0.60, width * 0.25, "paper", "soft", 0.46);
  }

  function dialHand(r, axis, length, width, height, angle, fill) {
    r.plane(...axis, height, angle - Math.PI / 2, () => {
      const path = new Path2D();
      path.moveTo(-3.4, -width * 0.65);
      path.lineTo(length - 3.2, -width);
      path.lineTo(length, 0);
      path.lineTo(length - 3.2, width);
      path.lineTo(-3.4, width * 0.65);
      path.closePath();
      r.outline(path, fill, "ink", 0.46);
    });
  }

  function drawDial(r, rotations) {
    const top = 33;
    const radius = 25.6;
    r.flange(...minuteAxis, 19.65, 1.57, top - 19.65, 0, "metal");
    for (const angle of [-2.6, -1.35, 2.55]) {
      const stud = offset(minuteAxis, 31.2, angle);
      r.flange(...stud, 5, 2.9, top - 9.8, 0, "side");
      armLink(r, stud, offset(minuteAxis, radius - 3, angle), top - 1.8, 2.1);
      r.hole(...stud, top - 1.75, 1.29);
    }
    r.flange(...minuteAxis, top - 2.1, radius, 2.1, 0, "paper");
    r.circle(...minuteAxis, top + 0.03, 23.9, null, "soft", 0.44);
    r.circle(...minuteAxis, top + 0.05, 17.6, null, "soft", 0.38);
    for (let i = 0; i < 60; i++) {
      const angle = i * tau / 60 - Math.PI / 2;
      const inner = i % 15 === 0 ? 18.7 : i % 5 === 0 ? 19.85 : 21.75;
      r.line([...offset(minuteAxis, inner, angle), top + 0.09],
        [...offset(minuteAxis, 22.85, angle), top + 0.09], i % 5 === 0 ? "ink" : "soft", i % 15 === 0 ? 1.24 : 0.49);
    }
    const traveled = rotations.minute - initialClock.minute;
    const initialTime = 10 * 3600 + 8 * 60;
    dialHand(r, minuteAxis, 13.9, 1.35, top + 0.57, initialTime * tau / 43200 + traveled / 12, "ink");
    dialHand(r, minuteAxis, 21.4, 1.0, top + 1.08, initialTime * tau / 3600 + traveled, "ink");
    r.flange(...minuteAxis, top + 1.1, 1.8, 1.25, 0, "side");
  }

  function drawSeconds(r, rotations) {
    const height = 29.5;
    const anchor = offset(secondsAxis, 14.3, 1.05);
    r.flange(...anchor, 5, 2.15, height - 6, 0, "side");
    const rim = new Path2D();
    rim.arc(0, 0, 10.2, 0, tau);
    rim.moveTo(8.1, 0);
    rim.arc(0, 0, 8.1, 0, tau);
    r.plane(...secondsAxis, height - 1.5, 0, () => r.outline(rim, "side"));
    r.plane(...secondsAxis, height, 0, () => r.outline(rim, "paper"));
    r.line([...offset(secondsAxis, 10.05, 1.05), height], [...anchor, height], "ink", 1.8);
    r.hole(...anchor, height + 0.03, 1.23);
    for (let i = 0; i < 12; i++) {
      const angle = i * tau / 12;
      r.line([...offset(secondsAxis, 8.5, angle), height + 0.04],
        [...offset(secondsAxis, 9.7, angle), height + 0.04], "ink", i % 3 === 0 ? 0.75 : 0.43);
    }
    r.flange(...secondsAxis, 27.2, 1.13, height - 25.7, 0, "metal");
    dialHand(r, secondsAxis, 8.4, 0.33, height + 0.92, rotations.seconds - initialClock.seconds + 0.35, "ink");
    r.circle(...secondsAxis, height + 1.02, 1.15, "recess", "line", 0.47);
  }

  function palletStone(side) {
    // Transform the contact face at the tooth tip back into the lever's coordinates.
    const angle = side * lockAngle;
    const [x, y] = polar(toothTip + 0.04, angle);
    const [nx, ny] = polar(1, angle);
    const [tx, ty] = [-ny, nx];
    const reverse = -side * banking;
    const c = Math.cos(reverse), s = Math.sin(reverse);
    return [[0, -1.35], [0, 1.35], [1.9, 1.35], [2.25, -1.35]].map(([a, b]) => {
      const dx = x + nx * a + tx * b - palletSpan, dy = y + ny * a + ty * b;
      return [dx * c - dy * s, dx * s + dy * c];
    });
  }

  const palletStones = [-1, 1].map(palletStone);

  function drawPallet(r, angle) {
    const z = 22.7;
    for (const side of [-1, 1]) {
      const bank = offset(palletCenter, 12.7, leverAxis + side * 0.27);
      r.flange(...bank, 5, 1.18, z - 4.2, 0, "metal");
    }
    r.flange(...palletCenter, 5, 1.63, z - 5, 0, "side");
    const outline = (points, fill, stroke = "line", weight = 0.57) => {
      const a = leverAxis + angle;
      const c = Math.cos(a), s = Math.sin(a);
      r.shape(points.map(([x, y]) => [palletCenter[0] + x * c - y * s,
        palletCenter[1] + x * s + y * c, z]), fill, stroke, weight);
    };
    for (const stone of palletStones) {
      const back = [(stone[2][0] + stone[3][0]) / 2, (stone[2][1] + stone[3][1]) / 2];
      outline([[-1.8, -1.18], [back[0] - 0.5, back[1] - 1.04],
        [back[0] + 0.96, back[1] + 0.9], [-1.1, 1.25]], "metal");
      outline(stone, "recess", "ink", 0.5);
    }
    outline([[-2.7, -1.7], [10.3, -1.35], [16.1, -2.64], [19, -2.5], [17.15, -0.77],
      [15.7, -0.58], [15.7, 0.58], [17.15, 0.77], [19, 2.5], [16.1, 2.64],
      [10.3, 1.35], [-2.7, 1.7]], "paper");
    r.flange(...palletCenter, z, 2.1, 1.0, 0, "side");
    r.circle(...palletCenter, z + 1.05, 0.77, "recess", "ink", 0.45);
  }

  const balanceRadius = 20.8;
  const balanceRim = new Path2D();
  for (const radius of [balanceRadius, balanceRadius - 2.85]) {
    balanceRim.moveTo(radius, 0);
    balanceRim.arc(0, 0, radius, 0, tau);
    balanceRim.closePath();
  }

  function drawBalance(r, angle, palletAngle) {
    const height = 33.3;
    r.flange(...balanceCenter, 5, 2.7, height - 6, 0, "side");
    r.flange(...balanceCenter, 20.4, 7.65, 1.05, 0, "flank");
    drawPallet(r, palletAngle);
    const impulse = offset(balanceCenter, 6.65, leverAxis + Math.PI + angle);
    r.flange(...impulse, 21.45, 0.83, 1.63, 0, "recess");
    for (const z of [height - 2.5, height - 1.25]) {
      r.plane(...balanceCenter, z, angle, () => r.outline(balanceRim, "flank", null));
    }
    for (let i = 0; i < 3; i++) {
      const tip = offset(balanceCenter, balanceRadius - 1.7, angle + i * tau / 3 + 0.3);
      armLink(r, balanceCenter, tip, height - 0.08, 1.32);
    }
    r.plane(...balanceCenter, height, angle, () => r.outline(balanceRim, "paper"));
    r.circle(...balanceCenter, height + 0.025, balanceRadius - 0.87, null, "soft", 0.36);
    for (let i = 0; i < 12; i++) {
      const direction = angle + i * tau / 12;
      const outer = offset(balanceCenter, balanceRadius - 1.43, direction);
      r.circle(...outer, height + 0.04, 0.58, "recess", "ink", 0.33);
    }
    r.flange(...balanceCenter, height, 2.9, 1.1, 0, "metal");
    drawCoil(r, balanceCenter, height + 2.15, 2.3, 11.9, 3.5, angle, 0.59);
    const stud = offset(balanceCenter, 11.9, Math.PI);
    r.flange(...stud, height + 1.5, 1.34, 1.44, 0, "side");
    // Two narrow, stationary supports expose the spring and the regulating rim.
    clockBridge(r, offset(balanceCenter, 23.8, -1.15), balanceCenter, height + 6.4, 2.0);
    const studBase = offset(balanceCenter, 22.4, 2.04);
    r.flange(...studBase, 5, 2.32, height - 4, 0, "metal");
    armLink(r, studBase, stud, height + 2.98, 1.08);
    r.hole(...studBase, height + 3.03, 0.91);
  }

  function displayClock(r, distance) {
    const pose = clockPose(distance);
    r.layer("plate", r => {
      const edge = [[-84, -65], [78, -65], [89, -54], [89, 2],
        [64, 30], [27, 48], [-84, 48], [-95, 38], [-95, -54]];
      const face = edge.map(([x, y]) => [x, y, 5]);
      r.shape(edge.map(([x, y]) => [x + 3.1, y + 4.1, 0]), "shadow", null);
      for (const i of [2, 3, 4, 5, 6]) {
        const a = face[i], b = face[i + 1];
        r.shape([a, b, [b[0], b[1], 0], [a[0], a[1], 0]], i === 5 ? "flank" : "side");
      }
      r.shape(face, "metal");
      const rim = edge.map(([x, y]) => [x * 0.958, (y + 7) * 0.94 - 7, 5.04]);
      r.shape([...rim, rim[0]], null, "soft", 0.48);
      for (const [x, y] of [[-86, -55], [-86, 37], [79, -54], [60, 26]]) {
        r.circle(x, y, 5.06, 2.62, "flank", "soft", 0.47);
        r.hole(x, y, 5.1, 1.56);
      }
      for (const axis of [minuteAxis, thirdAxis, secondsAxis, escapeAxis]) r.flange(...axis, 5, 2.18, 2.28, 0, "side");

    });
    r.flange(...barrelAxis, 5, 26.25, 3.4, 0, "side");
    r.circle(...barrelAxis, 8.43, barrelOpening, "flank", "soft", 0.46);
    drawCoil(r, barrelAxis, 8.50, 5.2, barrelOpening - 0.72, 5.5, pose.barrel, 0.66);
    gearFace(r, barrelAxis, 10.7, barrelWheel, pose.barrel);
    gearFace(r, minuteAxis, 10.7, minutePinion, pose.minute, "side");
    r.flange(...minuteAxis, 11.94, 1.75, 4.25, 0, "metal");
    r.flange(...secondsAxis, 7.25, 1.57, 3.45, 0, "metal");
    gearFace(r, secondsAxis, 13.7, secondsWheel, pose.seconds);
    r.flange(...escapeAxis, 7.26, 1.17, 3.55, 0, "metal");
    gearFace(r, escapeAxis, 13.7, escapePinion, pose.escape, "side");

    r.flange(...thirdAxis, 7.25, 1.6, 9.1, 0, "metal");
    gearFace(r, minuteAxis, 18.4, minuteWheel, pose.minute);
    gearFace(r, thirdAxis, 18.4, thirdPinion, pose.third, "side");
    r.flange(...thirdAxis, 19.6, 1.83, 4.64, 0, "metal");
    r.flange(...secondsAxis, 14.9, 1.55, 9.37, 0, "metal");
    r.flange(...escapeAxis, 14.95, 1.32, 6.0, 0, "metal");
    gearFace(r, escapeAxis, 22.7, { path: escapeWheel, bore: 2.2, rootRadius: 10.7 }, pose.escape);
    gearFace(r, thirdAxis, 26.2, thirdWheel, pose.third);
    gearFace(r, secondsAxis, 26.2, secondsPinion, pose.seconds, "side");

    clockBridge(r, offset(barrelAxis, 28.2, 2.1), barrelAxis, 16.2, 2.35);
    clockBridge(r, offset(thirdAxis, 26, -1.22), thirdAxis, 31.3, 2.14);
    drawBalance(r, pose.balance, pose.pallet);
    drawSeconds(r, pose);
    drawDial(r, pose);
  }

  function motionDistance(seconds) {
    const ramp = 1.65, initial = 0.21, max = 1;
    const t = Math.min(ramp, seconds);
    return initial * t + (max - initial) * t * t / (2 * ramp) + max * (seconds - t);
  }


  const machines = {
    production: (scene, distance) => singleLine(scene, distance, true),
    assembly: (scene, distance) => singleLine(scene, distance, false),
    sorter, gantry, rotary, clock: displayClock,
  };

  globalThis.ccdxToolMachines = context => {
    let identity, colors;
    const layers = new Map();
    return (style, { time, width, height, dpr, ink, surface }) => {
      const paint = machines[style];
      if (!paint) return;
      const next = [style, width, height, dpr, ink, surface].join("|");
      if (identity !== next) {
        identity = next;
        layers.clear();
        colors = palette(ink, surface);
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      const scene = renderer(context, width, height, colors, style === "production" ? "line" : style);
      scene.layer = (name, draw) => {
        let image = layers.get(name);
        if (!image) {
          image = document.createElement("canvas");
          image.width = context.canvas.width;
          image.height = context.canvas.height;
          const buffer = image.getContext("2d");
          buffer.setTransform(dpr, 0, 0, dpr, 0, 0);
          draw(renderer(buffer, width, height, colors, style === "production" ? "line" : style));
          buffer.restore();
          layers.set(name, image);
        }
        context.save();
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.drawImage(image, 0, 0);
        context.restore();
      };
      paint(scene, motionDistance(Math.max(0, time)));
      context.restore();
    };
  };
})();
