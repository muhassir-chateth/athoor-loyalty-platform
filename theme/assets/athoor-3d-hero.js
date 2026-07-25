/*
 * Athoor London — 3D Hero (bee orbiting a perfume bottle)
 * Vanilla Three.js + GSAP. No build step. Loaded as an ES module from a theme section.
 *
 * Design goals (mirrors the Beast / Santal Trouble reference):
 *   - Photoreal-ish bottle with HDRI reflections + ACES tonemapping + subtle bloom
 *   - Bee orbits the bottle, briefly lands, takes off again, never clips the bottle
 *   - Continuous wing flap (AnimationMixer if the GLB has clips, else procedural)
 *   - Soft contact shadow under the bottle, gentle float + mouse parallax
 *   - 60fps target: capped pixel ratio, render only while in viewport,
 *     graceful fallback (static image) on reduced-motion / low-power / no-WebGL
 *
 * All heavy assets (bee GLB, bottle GLB, HDRI) are passed in as URLs from the
 * section settings and should live in Shopify Files (CDN), NOT the theme assets folder.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { gsap } from 'gsap';

const DRACO_PATH = 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/';
const BASIS_PATH = 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/basis/';

/* ---------- capability detection ---------- */
function canRun() {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return false;
  } catch (e) { return false; }
  // crude low-power guard: very low memory or core count -> fallback image
  const mem = navigator.deviceMemory || 4;
  const cores = navigator.hardwareConcurrency || 4;
  if (mem <= 2 || cores <= 2) return false;
  return true;
}

function isMobile() {
  return window.matchMedia('(max-width: 749px)').matches;
}

class AthoorBeeHero {
  constructor(root) {
    this.root = root;
    this.canvas = root.querySelector('[data-bee-canvas]');
    this.fallback = root.querySelector('[data-bee-fallback]');
    this.word = root.querySelector('[data-bee-word]');
    this.opts = {
      beeUrl: root.dataset.beeUrl || '',
      bottleUrl: root.dataset.bottleUrl || '',
      bottleImage: root.dataset.bottleImage || '',
      hdriUrl: root.dataset.hdriUrl || '',
      bottleColor: root.dataset.bottleColor || '#5a2a16',
      bg: root.dataset.bg || '#ffffff',
      bloom: parseFloat(root.dataset.bloom || '0.6'),
      beeScale: parseFloat(root.dataset.beeScale || '1'),
    };
    this.mobile = isMobile();
    this.running = false;
    this.clock = new THREE.Clock();
    this.mixer = null;
    this.bee = null;
    this.beeWings = [];
    this.bottle = null;
    this.flightTl = null;
    this.pointer = { x: 0, y: 0 };

    this._initWhenVisible();
  }

  _showFallback() {
    if (this.fallback) this.fallback.style.display = '';
    if (this.canvas) this.canvas.style.display = 'none';
  }

  _initWhenVisible() {
    // On mobile, skip lazy-load observer — build immediately since hero is visible on load
    if (this.mobile) {
      this._build();
      return;
    }
    // Desktop: only build the scene when the hero scrolls into view (CWV friendly)
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          io.disconnect();
          this._build();
        }
      });
    }, { rootMargin: '200px' });
    io.observe(this.root);
  }

  _build() {
    const w = this.root.clientWidth;
    const h = this.root.clientHeight;

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: !this.mobile, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.mobile ? 1.5 : 2));
    this.renderer.setSize(w, h);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(new THREE.Color(this.opts.bg || '#ffffff'), 0); // transparent -> lets the background word show behind the bottle
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(35, w / h, 0.1, 100);
    this.camera.position.set(0, 0.4, 6.2);
    this.camera.lookAt(0, 0.2, 0);

    // group we tilt for mouse parallax
    this.world = new THREE.Group();
    this.scene.add(this.world);

    this._setupLights();
    this._setupEnvironment();
    this._setupGround();
    this._setupBottle();
    this._setupBee();
    this._setupComposer(w, h);

    window.addEventListener('resize', () => this._resize());

    // wake the bee on CLICK/TAP only (not hover or pointermove)
    // On mobile: use 'click' event (fires only after tap, NOT on scroll)
    // On desktop: use 'pointerdown' (fires immediately on click)
    const wake = () => this._wake();
    if (this.mobile) {
      this.root.addEventListener('click', wake);
    } else {
      this.root.addEventListener('pointerdown', wake);
    }

    // pause render loop when off-screen to save battery / main thread
    this.visObserver = new IntersectionObserver((entries) => {
      const vis = entries[0].isIntersecting;
      if (vis && !this.running) {
        this.clock.getDelta(); // flush the paused gap so motion resumes smoothly
        this.running = true;
        this._loop();
      } else {
        this.running = vis;
      }
    }, { threshold: 0.05 });
    this.visObserver.observe(this.root);
  }

  _setupLights() {
    const hemi = new THREE.HemisphereLight(0xffffff, 0xd9c9b8, 0.6);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(3, 5, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(this.mobile ? 1024 : 2048, this.mobile ? 1024 : 2048);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 20;
    key.shadow.bias = -0.0004;
    key.shadow.radius = 6;
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0xfff2e0, 0.8);
    rim.position.set(-4, 2, -3);
    this.scene.add(rim);
  }

  _setupEnvironment() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    if (this.opts.hdriUrl) {
      new RGBELoader().load(this.opts.hdriUrl, (hdr) => {
        const env = pmrem.fromEquirectangular(hdr).texture;
        this.scene.environment = env;
        hdr.dispose();
        pmrem.dispose();
      });
    } else {
      // neutral studio environment so glass/reflective materials still read well
      const room = new THREE.Scene();
      const geo = new THREE.SphereGeometry(10, 16, 16);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.BackSide });
      room.add(new THREE.Mesh(geo, mat));
      const env = pmrem.fromScene(room, 0.04).texture;
      this.scene.environment = env;
      pmrem.dispose();
    }
  }

  _setupGround() {
    // soft contact shadow catcher
    const geo = new THREE.PlaneGeometry(20, 20);
    const mat = new THREE.ShadowMaterial({ opacity: 0.18 });
    const ground = new THREE.Mesh(geo, mat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -1.35;
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  _makeLoader() {
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath(DRACO_PATH);
    loader.setDRACOLoader(draco);
    try {
      const ktx2 = new KTX2Loader().setTranscoderPath(BASIS_PATH).detectSupport(this.renderer);
      loader.setKTX2Loader(ktx2);
    } catch (e) { /* KTX2 optional */ }
    return loader;
  }

  _setupBottle() {
    this.bottleGroup = new THREE.Group();
    this.world.add(this.bottleGroup);

    if (this.opts.bottleImage) {
      this._buildImageBottle();
    } else if (this.opts.bottleUrl) {
      this._makeLoader().load(this.opts.bottleUrl, (gltf) => {
        const m = gltf.scene;
        m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        this._frameObject(m, 2.4);
        this.bottleGroup.add(m);
        this.bottle = m;
      }, undefined, () => this._buildProceduralBottle());
    } else {
      this._buildProceduralBottle();
    }
    this._floatBottle();
  }

  _buildImageBottle() {
    // Option B: float the product photo as a transparent plane.
    // alphaTest makes transparent pixels skip depth writing, so the bee shows
    // through empty areas but is correctly occluded behind the bottle pixels.
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    loader.load(this.opts.bottleImage, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      const targetH = 2.6;
      const aspect = (tex.image && tex.image.width && tex.image.height) ? tex.image.width / tex.image.height : 0.5;
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(targetH * aspect, targetH),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide, toneMapped: false })
      );
      this.bottleGroup.add(plane);
      this.bottle = plane;
    });
    // land on the front face of the photo, slightly proud of it (z > 0)
    this.landTarget = new THREE.Vector3(0.32, 0.45, 0.12);
  }

  _buildProceduralBottle() {
    // Stand-in bottle until a real GLB is supplied: amber glass body + black cap
    const body = new THREE.Mesh(
      new RoundedBoxLike(1.1, 1.9, 0.55, 0.12),
      new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(this.opts.bottleColor),
        roughness: 0.12, metalness: 0, transmission: this.mobile ? 0 : 0.35,
        thickness: 0.6, ior: 1.45, clearcoat: 0.6, clearcoatRoughness: 0.2,
        attenuationColor: new THREE.Color(this.opts.bottleColor), attenuationDistance: 1.2,
      })
    );
    body.castShadow = true; body.receiveShadow = true;

    const neck = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.28, 0.3, 32),
      new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.3, metalness: 0.2 })
    );
    neck.position.y = 1.05; neck.castShadow = true;

    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(0.36, 48, 48),
      new THREE.MeshStandardMaterial({ color: 0x0c0c0c, roughness: 0.18, metalness: 0.1 })
    );
    cap.position.y = 1.45; cap.castShadow = true;

    this.bottleGroup.add(body, neck, cap);
    this.bottle = this.bottleGroup;
    // surface point where the bee will land (front shoulder of the bottle)
    this.landTarget = new THREE.Vector3(0.35, 0.7, 0.45);
  }

  _floatBottle() {
    // Bottle stays perfectly steady (no bob/rotation) so the perched bee looks attached.
  }

  _setupBee() {
    if (this.opts.beeUrl) {
      this._makeLoader().load(this.opts.beeUrl, (gltf) => {
        const bee = gltf.scene;
        this._styleBee(bee);
        // This GLB uses the legacy KHR_materials_pbrSpecularGlossiness extension, which
        // modern three.js ignores -> bee renders white. The colour map IS embedded though,
        // so pull the diffuse (texture 0) + normal (texture 2) out and apply them manually.
        if (gltf.parser) {
          gltf.parser.getDependency('texture', 0).then((tex) => {
            tex.colorSpace = THREE.SRGBColorSpace;
            bee.traverse((o) => {
              if (o.isMesh && o.material) {
                o.material.map = tex;
                if (o.material.color) o.material.color.set(0xffffff);
                o.material.needsUpdate = true;
              }
            });
          }).catch(() => {});
          gltf.parser.getDependency('texture', 2).then((nrm) => {
            bee.traverse((o) => {
              if (o.isMesh && o.material) { o.material.normalMap = nrm; o.material.needsUpdate = true; }
            });
          }).catch(() => {});
        }
        this._normaliseBee(bee, 0.9);
        if (gltf.animations && gltf.animations.length) {
          this.mixer = new THREE.AnimationMixer(bee);
          gltf.animations.forEach((clip) => {
            const action = this.mixer.clipAction(clip);
            action.setLoop(THREE.LoopRepeat, Infinity);
            action.clampWhenFinished = false;
            action.play();
          });
        }
        this.beeRig.add(bee);
        this.bee = bee;
        this._startFlight();
      }, undefined, () => this._buildProceduralBee());
    } else {
      this._buildProceduralBee();
    }
  }

  _styleBee(bee) {
    // Keep the model's OWN materials/textures so it shows its real colours (exactly like
    // the Shopify 3D viewer). We only ensure shadows + disable frustum culling on the
    // skinned meshes, and make sure colour textures use the correct colour space.
    bee.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.frustumCulled = false; // skinned meshes get culled otherwise -> animation freezes
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => {
        if (!m) return;
        if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
        if (m.emissiveMap) m.emissiveMap.colorSpace = THREE.SRGBColorSpace;
        m.needsUpdate = true;
      });
    });
  }

  _buildProceduralBee() {
    const bee = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.6 });
    const stripeMat = new THREE.MeshStandardMaterial({ color: 0xf0b429, roughness: 0.5 });

    const thorax = new THREE.Mesh(new THREE.SphereGeometry(0.18, 24, 24), bodyMat);
    const abdomen = new THREE.Mesh(new THREE.SphereGeometry(0.22, 24, 24), stripeMat);
    abdomen.position.set(0, 0, -0.28); abdomen.scale.set(1, 0.9, 1.3);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 20, 20), bodyMat);
    head.position.set(0, 0, 0.22);
    [thorax, abdomen, head].forEach((m) => { m.castShadow = true; });

    const wingMat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, transmission: 0.9, transparent: true, opacity: 0.5, roughness: 0.1, side: THREE.DoubleSide });
    const wingGeo = new THREE.PlaneGeometry(0.42, 0.2);
    const wL = new THREE.Mesh(wingGeo, wingMat); wL.position.set(-0.18, 0.12, -0.05); wL.rotation.z = 0.3;
    const wR = new THREE.Mesh(wingGeo, wingMat); wR.position.set(0.18, 0.12, -0.05); wR.rotation.z = -0.3;
    this.beeWings = [wL, wR];

    bee.add(thorax, abdomen, head, wL, wR);
    this._normaliseBee(bee, 0.5);
    this.beeRig.add(bee);
    this.bee = bee;
    this._startFlight();
  }

  _normaliseBee(bee, targetSize) {
    if (!this.beeRig) { this.beeRig = new THREE.Group(); this.world.add(this.beeRig); }
    // Geometry-based bounds (reliable for skinned/animated meshes, unlike setFromObject)
    bee.updateWorldMatrix(true, true);
    const box = new THREE.Box3();
    bee.traverse((o) => {
      if (o.isMesh && o.geometry) {
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        const bb = o.geometry.boundingBox;
        if (!bb) return;
        for (let i = 0; i < 8; i++) {
          const c = new THREE.Vector3(
            i & 1 ? bb.max.x : bb.min.x,
            i & 2 ? bb.max.y : bb.min.y,
            i & 4 ? bb.max.z : bb.min.z
          ).applyMatrix4(o.matrixWorld);
          box.expandByPoint(c);
        }
      }
    });
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const s = (targetSize / maxDim) * (this.opts.beeScale || 1);
    bee.scale.setScalar(s);
    // re-center so the bee pivots around its own middle inside the rig
    bee.position.copy(center.multiplyScalar(-s));
    this._beeBasePos = bee.position.clone(); // locked body position used at rest (kills float)
  }

  _startFlight() {
    // Continuous blend model — NO snaps/cuts. The bee rests on the bottle (facing us),
    // and when woken it eases (blend w: 0->1) onto a seamless looping flight path that
    // is a smooth function of one ever-advancing phase. Easing back (w: 1->0) returns it
    // to the exact same perch. Nothing ever resets, so the motion never glitches.
    this._perch = this.mobile
      ? new THREE.Vector3(-0.4, 0.34, 0.14)     // mobile: body on the left edge, touching the glass
      : new THREE.Vector3(-0.46, 0.55, 0.14);   // desktop: body on the left edge, touching the glass
    this._restQuat = (() => {
      const aim = new THREE.Object3D();
      aim.position.copy(this._perch);
      aim.up.set(0, 1, 0);
      aim.lookAt(0, this._perch.y + 0.22, 0); // head toward the bottle edge, slightly up = sniffing the bottle
      return aim.quaternion.clone();
    })();
    this._fly = this.mobile
      ? { speed: 2.0, baseR: 1.3, radAmp: 0.4, baseY: 0.62, yAmp: 0.3, wideX: 1.15 }   // higher baseline so it doesn't dip low
      : { speed: 2.2, baseR: 1.7, radAmp: 0.6, baseY: 0.72, yAmp: 0.38, wideX: 1.7 };
    this._ph = Math.PI * 0.9;   // phase starts near the left (perch side) for a short ease-in
    this._w = 0;                // 0 = resting, 1 = full flight
    this._wTarget = 0;
    this._wRate = 0.9;          // ramp-in speed (~1.1s to reach full flight)
    this._state = 'intro';
    this.beeRig.quaternion.copy(this._restQuat);
    this._prevPos = this.beeRig.position.clone();
    this._intro();
  }

  _intro() {
    // First load: appear from the RIGHT (off-screen, slightly large), roam around the
    // bottle using the normal continuous flight, then ease down to the agreed perch.
    this._state = 'fly';
    this._w = 1; this._wTarget = 1;       // start already in flight
    this._ph = 0;                          // phase 0 = right side of the orbit
    this._introBlend = 1;                  // sweep-in offset (decays to 0)
    this._introOffset = this.mobile
      ? new THREE.Vector3(2.4, 0.3, 1.8)   // smaller pop-in so it doesn't fly off a phone screen
      : new THREE.Vector3(4.0, 0.4, 2.6);  // far right + much closer to camera => big 3D pop-in
    this._wantLand = false;
    this._setWingSpeed(1);
    this._prevPos.copy(this.beeRig.position);
    this._flyUntil = this.clock.elapsedTime + 6; // roam ~6s (2 orbits), then land on the perch
    this._setWord(false); // hide the product name while flying
  }

  _setWingSpeed(s) {
    this._wingSpeed = s;
    if (this.mixer) this.mixer.timeScale = s;
  }

  _setWord(visible) {
    if (this.word) this.word.classList.toggle('is-visible', visible);
  }

  _wake() {
    if (this._state === 'intro') return; // let the entrance finish first
    if (this._state !== 'fly') { this._state = 'fly'; this._setWingSpeed(1); }
    this._wTarget = 1;
    this._setWord(false); // hide the product name while it roams
    // 2 orbits: ~6s at speed 2.0-2.2 rad/s (2π * 2 / speed ≈ 5.7-6.3s)
    this._flyUntil = this.clock.elapsedTime + 6;
  }

  _faceVelocity() {
    const p = this.beeRig.position;
    const v = p.clone().sub(this._prevPos);
    this._prevPos.copy(p);
    if (v.lengthSq() < 1e-5) return;                 // too slow -> keep current heading (no jitter/flip)
    if (!this._aim) this._aim = new THREE.Object3D();
    this._aim.position.copy(p);
    this._aim.up.set(0, 1, 0);
    this._aim.lookAt(p.x + v.x, p.y + v.y, p.z + v.z);
    this.beeRig.quaternion.slerp(this._aim.quaternion, 0.18); // smooth turn -> never snaps backward
  }

  _setupComposer(w, h) {
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    if (!this.mobile && this.opts.bloom > 0) {
      const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), this.opts.bloom, 0.4, 0.85);
      this.composer.addPass(bloom);
    }
    this.composer.addPass(new OutputPass());
  }

  _onPointer(e) {
    this._bottleZoom = 1.03; // brief, very slight zoom while the cursor moves
  }

  _resize() {
    const w = this.root.clientWidth, h = this.root.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    if (this.composer) this.composer.setSize(w, h);
  }

  _loop() {
    if (!this.running) return;
    const dt = Math.min(this.clock.getDelta(), 0.05); // clamp spikes -> no jank/jumps on first run or resume
    const t = this.clock.elapsedTime;

    // bee: entrance + continuous flight + dedicated smooth landing
    if (this._fly && this._state !== 'intro') {
      const f = this._fly;

      if (this._state === 'landing') {
        // Decelerating glide to the perch. Face the direction of travel for most of the
        // descent (natural fly-in, no twisting), then ease into the clinging pose at the end.
        this._landT = Math.min(1, this._landT + dt / 1.8);
        const tt = this._landT;
        const k = 1 - (1 - tt) * (1 - tt); // easeOutQuad position
        this.beeRig.position.lerpVectors(this._landFrom, this._perch, k);
        this.beeRig.scale.setScalar(this._landFromScale + (1 - this._landFromScale) * k);
        if (tt < 0.6) {
          this._faceVelocity();                                  // fly in facing its path
        } else {
          this.beeRig.quaternion.slerp(this._restQuat, 0.14);    // tuck into clinging pose
          this._prevPos.copy(this.beeRig.position);
        }
        if (this._landT >= 1) {
          this.beeRig.position.copy(this._perch);
          this.beeRig.quaternion.copy(this._restQuat);
          this._state = 'rest'; this._w = 0; this._wTarget = 0; this._setWingSpeed(0.45); // wings flutter, body locked
        }
      } else {
        // when the flight window ends, flag for landing but keep flying until the bee
        // reaches the front-left (so the approach never crosses behind/through the bottle)
        if (this._state === 'fly' && this.clock.elapsedTime > this._flyUntil) this._wantLand = true;

        // advance the flight phase continuously while not fully at rest
        if (this._state === 'fly' || this._w > 0.001) this._ph += f.speed * dt;
        if (this._w < this._wTarget) this._w = Math.min(this._wTarget, this._w + dt * this._wRate);
        else if (this._w > this._wTarget) this._w = Math.max(this._wTarget, this._w - dt * 0.7);
        const e = this._w * this._w * (3 - 2 * this._w); // smoothstep

        // seamless looping path (smooth functions of phase -> never resets)
        const radius = f.baseR + Math.sin(this._ph * 0.7) * f.radAmp;
        let px = Math.cos(this._ph) * radius * (f.wideX || 1); // spread wider horizontally -> uses the hero width
        let pz = Math.sin(this._ph) * radius;
        let py = f.baseY + Math.sin(this._ph * 1.1) * f.yAmp;

        // one-time entrance: sweep in from the right (offset decays to zero)
        let introScale = 1;
        if (this._introBlend > 0) {
          this._introBlend = Math.max(0, this._introBlend - dt / 2.4);
          const ib = this._introBlend * this._introBlend;
          px += this._introOffset.x * ib;
          py += this._introOffset.y * ib;
          pz += this._introOffset.z * ib;
          introScale = 1 + this._introBlend * 1.3;   // enters much bigger, eases down to normal
        }

        const rx = this._perch.x;
        const ry = this._perch.y;   // no idle bob -> stays firmly gripped at rest
        const rz = this._perch.z;
        this.beeRig.position.set(rx + (px - rx) * e, ry + (py - ry) * e, rz + (pz - rz) * e);

        const depthScale = 1 + (pz / (f.baseR + f.radAmp)) * 0.42 * e;
        this.beeRig.scale.setScalar(depthScale * introScale);

        if (e > 0.06) {
          this._faceVelocity();
        } else {
          // resting: subtle "alive" idle — slow look-around + tiny head nod, body stays put
          if (!this._idleQ) { this._idleQ = new THREE.Quaternion(); this._idleE = new THREE.Euler(); this._restTargetQ = new THREE.Quaternion(); }
          const yaw = Math.sin(t * 0.7) * 0.22 + Math.sin(t * 0.27) * 0.06;   // gentle look (won't swing to centre)
          const nod = Math.sin(t * 1.9) * 0.1 + Math.sin(t * 0.9) * 0.05;     // visible head nod / groom
          const roll = Math.sin(t * 0.6) * 0.06;
          this._idleE.set(nod, yaw, roll);
          this._idleQ.setFromEuler(this._idleE);
          this._restTargetQ.copy(this._restQuat).multiply(this._idleQ);
          this.beeRig.quaternion.slerp(this._restTargetQ, 0.12);
          this._prevPos.copy(this.beeRig.position);
        }

        // begin landing only when the bee is at the front-left (sin>0 front, cos<0 left)
        if (this._wantLand && this._state === 'fly' && Math.sin(this._ph) > 0.3 && Math.cos(this._ph) < -0.05) {
          this._state = 'landing';
          this._landT = 0;
          this._wantLand = false;
          this._landFrom = this.beeRig.position.clone();
          this._landFromScale = this.beeRig.scale.x;
          this._landFromQuat = this.beeRig.quaternion.clone();
          this._setWingSpeed(0.6);
          this._setWord(true); // reveal the product name as it lands
        }
      }
    }

    // procedural wing flap (only when we built the fallback bee)
    if (this.beeWings.length) {
      const flap = Math.sin(t * 38) * 0.7 + 0.4;
      this.beeWings[0].rotation.z = 0.3 + flap;
      this.beeWings[1].rotation.z = -0.3 - flap;
    }
    if (this.mixer) this.mixer.update(dt);
    // during landing and at rest, cancel body translation baked into the model's clip
    // (wings still animate, but the body follows the clean path / stays locked = no float)
    if ((this._state === 'rest' || this._state === 'landing') && this.bee && this._beeBasePos) {
      this.bee.position.copy(this._beeBasePos);
    }

    // bottle stays completely steady (no cursor effect)

    this.renderer.render(this.scene, this.camera); // direct render keeps the canvas transparent (white page shows, never black)
    requestAnimationFrame(() => this._loop());
  }
}

/* small helper: rounded box without extra deps (approximate, good enough for stand-in bottle) */
function RoundedBoxLike(w, h, d, r) {
  // three's BoxGeometry rounded via simple bevel approximation using a Shape extrude
  const shape = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  shape.moveTo(x + r, y);
  shape.lineTo(x + w - r, y);
  shape.quadraticCurveTo(x + w, y, x + w, y + r);
  shape.lineTo(x + w, y + h - r);
  shape.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  shape.lineTo(x + r, y + h);
  shape.quadraticCurveTo(x, y + h, x, y + h - r);
  shape.lineTo(x, y + r);
  shape.quadraticCurveTo(x, y, x + r, y);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: true, bevelThickness: r * 0.6, bevelSize: r * 0.6, bevelSegments: 4, steps: 1, curveSegments: 12 });
  geo.center();
  return geo;
}

AthoorBeeHero.prototype._frameObject = function (obj, targetHeight) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const s = targetHeight / (size.y || 1);
  obj.scale.setScalar(s);
  const box2 = new THREE.Box3().setFromObject(obj);
  const center = box2.getCenter(new THREE.Vector3());
  obj.position.sub(center);
};

/* ---------- bootstrap ---------- */
function initAll() {
  document.querySelectorAll('[data-athoor-bee-hero]').forEach((root) => {
    if (root.__beeInit) return;
    root.__beeInit = true;
    if (!canRun()) {
      if (root.querySelector('[data-bee-fallback]')) {
        root.querySelector('[data-bee-fallback]').style.display = '';
        const c = root.querySelector('[data-bee-canvas]'); if (c) c.style.display = 'none';
      }
      return;
    }
    try { new AthoorBeeHero(root); } catch (e) { console.error('[AthoorBeeHero]', e); }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAll);
} else {
  initAll();
}
// re-init when a merchant drops the section in the theme editor
document.addEventListener('shopify:section:load', initAll);
