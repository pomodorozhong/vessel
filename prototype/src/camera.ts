import { mat4, vec3 } from 'wgpu-matrix';

// Fixed-angle top-down camera that follows a point on the sim plane (XY), Z up.
export class Camera {
  viewProj = mat4.create();
  private view = mat4.create();
  private proj = mat4.create();
  private eye = vec3.create();
  private target = vec3.create();
  private up = vec3.fromValues(0, 0, 1);
  // Half-size of the ground area that can be on screen, for culling (set by update()).
  halfW = 0; halfH = 0; cx = 0; cy = 0;
  constructor(public distance = 34, public pitch = 58 * Math.PI / 180, public fov = 40 * Math.PI / 180) {}
  update(x: number, y: number, aspect: number) {
    const c = Math.cos(this.pitch), s = Math.sin(this.pitch);
    vec3.set(x, y, 0, this.target);
    vec3.set(x, y - this.distance * c, this.distance * s, this.eye);
    mat4.lookAt(this.eye, this.target, this.up, this.view);
    mat4.perspective(this.fov, aspect, 1, 400, this.proj);
    mat4.multiply(this.proj, this.view, this.viewProj);
    // Conservative ground rectangle that covers the view frustum (the far edge is the wide one).
    const t = Math.tan(this.fov / 2);
    const far = this.distance * s / Math.max(0.2, Math.sin(this.pitch - this.fov / 2));
    this.halfW = far * t * aspect * 1.05;
    const near = this.distance * s / Math.sin(this.pitch + this.fov / 2);
    const yFar = -this.distance * c + far * Math.cos(this.pitch - this.fov / 2);
    const yNear = -this.distance * c + near * Math.cos(this.pitch + this.fov / 2);
    this.cx = x; this.cy = y + (yFar + yNear) / 2; this.halfH = (yFar - yNear) / 2 * 1.05;
  }
}
