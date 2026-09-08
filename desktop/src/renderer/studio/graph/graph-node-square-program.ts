/**
 * A rounded, edge-softened square node program.
 *
 * The stock square program fills its two triangles with a flat colour and
 * no edge treatment, so a square node reads as a hard pixel block beside
 * the circle program's softened disc. This program keeps the same
 * geometry (six vertices around the node's centre) and adds the two
 * things the circle already has: a corner radius and a one-pixel fade at
 * the edge, both computed per fragment from the vertex's offset.
 *
 * Sizes follow the circle program's convention: `a_size` is the node's
 * radius in screen pixels, and the square is drawn to the same footprint
 * (half-side equals the radius) so the shape channel swaps shape without
 * changing how much stage a node covers.
 */

import { NodeProgram, type InstancedProgramDefinition, type ProgramInfo } from 'sigma/rendering'
import type { NodeDisplayData, RenderParams } from 'sigma/types'
import { floatColor } from 'sigma/utils'

const VERTEX_SHADER = /* glsl */ `
attribute vec4 a_id;
attribute vec4 a_color;
attribute vec2 a_position;
attribute float a_size;
attribute float a_angle;

uniform mat3 u_matrix;
uniform float u_sizeRatio;
uniform float u_correctionRatio;

varying vec4 v_color;
varying vec2 v_diffVector;
varying float v_halfSide;

const float bias = 255.0 / 254.0;
const float sqrt_8 = sqrt(8.0);

void main() {
  float size = a_size * u_correctionRatio / u_sizeRatio * sqrt_8;
  vec2 diffVector = size * vec2(cos(a_angle), sin(a_angle));
  vec2 position = a_position + diffVector;
  gl_Position = vec4((u_matrix * vec3(position, 1)).xy, 0, 1);

  v_diffVector = diffVector;
  // The corner sits at distance size along a diagonal, so the half-side
  // is size / sqrt(2), which matches the circle program's radius of size / 2
  // scaled to the same a_size.
  v_halfSide = size / sqrt(2.0);

  #ifdef PICKING_MODE
  v_color = a_id;
  #else
  v_color = a_color;
  #endif
  v_color.a *= bias;
}
`

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

varying vec4 v_color;
varying vec2 v_diffVector;
varying float v_halfSide;

uniform float u_correctionRatio;

const vec4 transparent = vec4(0.0, 0.0, 0.0, 0.0);

void main(void) {
  float edge = u_correctionRatio * 2.0;
  // Corner radius is a fixed fraction of the side, so a small node stays
  // a square with softened corners and a large one reads as a card.
  float radius = v_halfSide * 0.28;
  vec2 q = abs(v_diffVector) - vec2(v_halfSide - radius);
  float dist = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;

  #ifdef PICKING_MODE
  if (dist > 0.0) gl_FragColor = transparent;
  else gl_FragColor = v_color;
  #else
  float t = clamp((dist + edge) / edge, 0.0, 1.0);
  gl_FragColor = mix(v_color, transparent, t);
  #endif
}
`

const UNIFORMS = ['u_sizeRatio', 'u_correctionRatio', 'u_matrix'] as const
const QUARTER = Math.PI / 4

export class NodeRoundedSquareProgram extends NodeProgram<(typeof UNIFORMS)[number]> {
  getDefinition(): InstancedProgramDefinition<(typeof UNIFORMS)[number]> {
    return {
      VERTICES: 6,
      VERTEX_SHADER_SOURCE: VERTEX_SHADER,
      FRAGMENT_SHADER_SOURCE: FRAGMENT_SHADER,
      METHOD: WebGLRenderingContext.TRIANGLES,
      UNIFORMS,
      ATTRIBUTES: [
        { name: 'a_position', size: 2, type: WebGLRenderingContext.FLOAT },
        { name: 'a_size', size: 1, type: WebGLRenderingContext.FLOAT },
        { name: 'a_color', size: 4, type: WebGLRenderingContext.UNSIGNED_BYTE, normalized: true },
        { name: 'a_id', size: 4, type: WebGLRenderingContext.UNSIGNED_BYTE, normalized: true },
      ],
      CONSTANT_ATTRIBUTES: [{ name: 'a_angle', size: 1, type: WebGLRenderingContext.FLOAT }],
      // Two triangles covering the square: corners at the four diagonals.
      CONSTANT_DATA: [[QUARTER], [3 * QUARTER], [-QUARTER], [3 * QUARTER], [-QUARTER], [-3 * QUARTER]],
    }
  }

  processVisibleItem(nodeIndex: number, startIndex: number, data: NodeDisplayData): void {
    const array = this.array
    array[startIndex++] = data.x
    array[startIndex++] = data.y
    array[startIndex++] = data.size
    array[startIndex++] = floatColor(data.color)
    array[startIndex++] = nodeIndex
  }

  setUniforms(params: RenderParams, { gl, uniformLocations }: ProgramInfo): void {
    const { u_sizeRatio, u_correctionRatio, u_matrix } = uniformLocations
    gl.uniform1f(u_sizeRatio, params.sizeRatio)
    gl.uniform1f(u_correctionRatio, params.correctionRatio)
    gl.uniformMatrix3fv(u_matrix, false, params.matrix)
  }
}
