/**
 * Lightweight tree node representation for exported LightGBM decision trees.
 */
export interface GbdtNode {
  leaf_value?: number,
  split_feature?: number,
  threshold?: number,
  left_child?: GbdtNode,
  right_child?: GbdtNode,
}

/**
 * Encapsulates a single decision tree within the LightGBM ensemble.
 */
export interface GbdtTree {
  tree_structure: GbdtNode,
}

/**
 * Calibration configuration for post-processing model margin scores.
 */
export interface GbdtCalibrationConfig {
  method: 'platt' | 'none',
  a: number,
  b: number,
}

/**
 * Complete structure of the exported LightGBM model dump.
 */
export interface GbdtModelJson {
  name: string,
  version: string,
  num_features: number,
  feature_names: string[],
  calibration?: GbdtCalibrationConfig,
  tree_info: GbdtTree[],
}

/**
 * Result returned by the boundary prediction cascade.
 */
export interface GbdtPredictionResult {
  decision: 0 | 1,
  confidence: number,
  reason: string,
}

/**
 * Minimal interface representing text pieces evaluated by the cascade rules.
 */
export interface PartialTextPiece {
  text?: string,
}

/**
 * Pure TypeScript LightGBM Decision Tree Evaluator.
 * Executes binary boundary classification directly in the browser with zero external dependencies in microseconds.
 */
export class GBDTEvaluator {
  public readonly trees: GbdtTree[];
  public readonly numTrees: number;
  public readonly featureNames: string[];

  /**
   * Initializes the evaluator with an exported LightGBM JSON model dump.
   *
   * @param modelJson The parsed LightGBM model JSON.
   */
  constructor(public readonly modelJson: GbdtModelJson) {
    this.trees = modelJson.tree_info || [];
    this.numTrees = this.trees.length;
    this.featureNames = modelJson.feature_names || [];
  }

  /**
   * Evaluates a single tree node recursively for a given feature vector.
   *
   * @param node The current tree node.
   * @param features The 30-element feature vector.
   * @returns The evaluated leaf value contribution.
   */
  public evaluateTree(node: GbdtNode, features: number[]): number {
    if (node.leaf_value !== undefined) {
      return node.leaf_value;
    }

    const featIdx = node.split_feature ?? 0;
    const threshold = node.threshold ?? 0.0;
    const featVal = features[featIdx] !== undefined ? features[featIdx] : 0.0;

    if (featVal <= threshold) {
      return node.left_child ? this.evaluateTree(node.left_child, features) : 0.0;
    } else {
      return node.right_child ? this.evaluateTree(node.right_child, features) : 0.0;
    }
  }

  /**
   * Computes the uncalibrated raw margin score (sum of leaf values across ensemble trees).
   *
   * @param features 30-element numeric array of extracted boundary features.
   * @returns Raw score (logit margin) across all ensemble trees.
   */
  public predictRawScore(features: number[]): number {
    let rawScore = 0.0;
    for (let i = 0; i < this.numTrees; i++) {
      rawScore += this.evaluateTree(this.trees[i].tree_structure, features);
    }
    return rawScore;
  }

  /**
   * Predicts the probability P(JOIN) for a 30-feature vector.
   * Applies Platt calibration if calibrated scaling parameters are specified in the model configuration.
   *
   * @param features 30-element numeric array of extracted boundary features.
   * @returns Calibrated or standard sigmoid probability of JOIN (class 1) in [0, 1].
   */
  public predictProba(features: number[]): number {
    const rawScore = this.predictRawScore(features);
    const cal = this.modelJson.calibration;
    if (cal && cal.method === 'platt') {
      const calibratedLogit = (cal.a * rawScore) + cal.b;
      return 1.0 / (1.0 + Math.exp(-calibratedLogit));
    }
    return 1.0 / (1.0 + Math.exp(-rawScore));
  }

  /**
   * Hybrid Book 2-Stage Cascade combining domain layout heuristics with universal GBDT inference.
   *
   * @param features The 30-element extracted feature vector.
   * @param pieceA The preceding text piece.
   * @param pieceB The succeeding text piece.
   * @returns The arbitration decision, confidence level, and rationale.
   */
  public predictCascade(
    features: number[],
    pieceA: PartialTextPiece,
    _pieceB: PartialTextPiece
  ): GbdtPredictionResult {
    const txtA = (pieceA.text || '').trim();

    // Rule 1: Bullet marker or lone bullet character must ALWAYS join to following text.
    if ((/^[•\-*–—]$/).test(txtA)) {
      return { decision: 1, confidence: 1.0, reason: 'Rule: Bullet marker joined to item text' };
    }

    // Rule 2: Short requirement code / section ID (e.g. 'RF1', 'MVP:') on same line or immediate continuation.
    if ((/^(?:RF\d+|MVP:?|P\d+|[A-Z]\d+[.)]?)$/i).test(txtA)) {
      return { decision: 1, confidence: 0.99, reason: 'Rule: Requirement/Section ID joined to host phrase' };
    }

    // Rule 3: Piece A ends with a hyphen or dash (word continuation across line boundary).
    if (txtA.endsWith('-') || txtA.endsWith('–') || txtA.endsWith('—')) {
      return { decision: 1, confidence: 0.99, reason: 'Rule: Hyphenated word continuation' };
    }

    // Rule 4: Universal GBDT probability arbitration.
    const prob = this.predictProba(features);
    if (prob >= 0.85) {
      return { decision: 1, confidence: prob, reason: 'GBDT: High confidence line continuation' };
    } else if (prob <= 0.15) {
      return { decision: 0, confidence: 1.0 - prob, reason: 'GBDT: High confidence paragraph break' };
    } else {
      return {
        decision: prob >= 0.5 ? 1 : 0,
        confidence: Math.max(prob, 1.0 - prob),
        reason: 'GBDT Arbiter (Borderline)'
      };
    }
  }
}
