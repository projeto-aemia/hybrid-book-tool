import { TestBed } from '@angular/core/testing';

import { TextSegmentationService, TextSegment } from './text-segmentation';
import { mockSegments } from '../../../../test-assets/mock-data.json';
import { TextContent } from 'ngx-extended-pdf-viewer';

describe('TextSegmentationService', () => {
  let service: TextSegmentationService;

  /**
   * Creates a deep clone of the mock segments data configured with sample parent-child relationships for testing.
   * 
   * @returns An array of `TextSegment` objects with hierarchical parent-child relationships.
   */
  function createTestSegments(): TextSegment[] {
    const segments: TextSegment[] = structuredClone(mockSegments);

    // Setup hierarchical parent-child relationships for tests:
    // segments[0]: parent with 0 children
    // segments[1]: parent with 2 children (linking segments 2 and 3)
    // segments[4]: parent with 1 child (linking segment 5)
    // The remaining segments remain flat parent segments.
    const child1 = segments[2];
    const child2 = segments[3];
    const child3 = segments[5];

    segments[1].linkedChildren = [child1, child2];
    segments[4].linkedChildren = [child3];

    // Remove children from top level array in reverse index order.
    segments.splice(5, 1);
    segments.splice(2, 2);

    return segments;
  }

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(TextSegmentationService);

    service.segments.set(createTestSegments());
  });

  it('should be created and initially have segments', () => {
    expect(service).toBeTruthy();
    const segments = service.segments();
    expect(segments.length).toBeGreaterThan(0);
  });

  it('toggleSegmentLinking should link a parent segment into previous parent as child', () => {
    const segmentsBefore = service.segments();
    const parentIndex = segmentsBefore.findIndex((s, i) => i > 0 && s.text && !s.excluded);
    expect(parentIndex).toBeGreaterThan(-1);

    const parent = segmentsBefore[parentIndex];
    const prev = segmentsBefore[parentIndex - 1];
    const originalLength = segmentsBefore.length;

    service.toggleSegmentLinking(parent.pdfJsId);

    const segmentsAfter = service.segments();
    
    // Length should decrease by 1 because parent moved into previous' linkedChildren.
    expect(segmentsAfter.length).toBe(originalLength - 1);

    // Previous parent's linkedChildren should include the moved segment.
    const updatedPrev = segmentsAfter.find((s) => s.pdfJsId === prev.pdfJsId) as TextSegment;
    expect(updatedPrev.linkedChildren.some((c) => c.pdfJsId === parent.pdfJsId)).toBe(true);
  });

  it('toggleSegmentLinking should unlink a child into a parent segment', () => {
    // Pick a parent that has at least two children so we can take a middle child.
    const segments = service.segments();
    const parentIdx = segments.findIndex((s) => s.linkedChildren.length >= 2);
    expect(parentIdx).toBeGreaterThan(-1);

    const parent = segments[parentIdx];
    const child = parent.linkedChildren[0];

    // Unlink the first child (should be promoted into parent position at parentIdx + 1).
    service.toggleSegmentLinking(child.pdfJsId);

    const updated = service.segments();
    const promoted = updated[parentIdx + 1];
    expect(promoted.pdfJsId).toBe(child.pdfJsId);
    
    // Its linkedChildren should be any successor children (may be empty).
    expect(promoted.linkedChildren).toBeDefined();
  });

  it('toggleSegmentLinking should not allow linking the first segment', () => {
    const segments = service.segments();
    const firstSegment = segments[0];
    expect(() => service.toggleSegmentLinking(firstSegment.pdfJsId)).toThrow('Cannot link the first segment.');
  });

  it('excludeSegment should promote first child when excluding a parent with children', () => {
    const segments = service.segments();
    const parentIndex = segments.findIndex((s) => s.linkedChildren.length > 0);
    expect(parentIndex).toBeGreaterThan(-1);

    const parent = segments[parentIndex];
    const firstChild = parent.linkedChildren[0];
    const firstChildLinkedChildren = firstChild.linkedChildren.map((c) => c.pdfJsId);
    const remainingSiblingIds = parent.linkedChildren.slice(1).map((c) => c.pdfJsId);

    service.excludeSegment(parent.pdfJsId);

    const updated = service.segments();
    const excludedParent = updated.find((s) => s.pdfJsId === parent.pdfJsId) as TextSegment;
    const promotedChild = updated[parentIndex + 1];
    expect(excludedParent.excluded).toBe(true);
    expect(excludedParent.linkedChildren).toEqual([]);
    expect(promotedChild.pdfJsId).toBe(firstChild.pdfJsId);
    expect(promotedChild.linkedChildren.map((c) => c.pdfJsId)).toEqual([
      ...firstChildLinkedChildren,
      ...remainingSiblingIds
    ]);
  });

  it('excludeSegment should only mark parent as excluded when it has no children', () => {
    const segments = service.segments();
    const parentIndex = segments.findIndex((s) => s.linkedChildren.length === 0);
    expect(parentIndex).toBeGreaterThan(-1);
    const parent = segments[parentIndex];
    const parentIdsBefore = segments.map((s) => s.pdfJsId);

    service.excludeSegment(parent.pdfJsId);

    const updated = service.segments();
    const parentIdsAfter = updated.map((s) => s.pdfJsId);
    const excludedParent = updated.find((s) => s.pdfJsId === parent.pdfJsId) as TextSegment;
    expect(parentIdsAfter).toEqual(parentIdsBefore);
    expect(excludedParent.excluded).toBe(true);
  });

  it('excludeSegment should promote child to parent position after its parent', () => {
    const segments = service.segments();
    const parentIndex = segments.findIndex((s) => s.linkedChildren.length > 0);
    expect(parentIndex).toBeGreaterThan(-1);
    const parent = segments[parentIndex];
    const childIndex = 0;
    const child = parent.linkedChildren[childIndex];

    service.excludeSegment(child.pdfJsId);

    const updated = service.segments();
    const updatedParent = updated.find((s) => s.pdfJsId === parent.pdfJsId) as TextSegment;
    const promotedChild = updated[parentIndex + 1];
    expect(updatedParent.linkedChildren.some((c) => c.pdfJsId === child.pdfJsId)).toBe(false);
    expect(promotedChild.pdfJsId).toBe(child.pdfJsId);
    expect(promotedChild.excluded).toBe(true);
  });

  it('includeSegment should include an excluded segment without changing segment order', () => {
    const segments = service.segments();
    const parentIndex = segments.findIndex((s) => s.linkedChildren.length === 0);
    expect(parentIndex).toBeGreaterThan(-1);
    const segment = segments[parentIndex];

    service.excludeSegment(segment.pdfJsId);
    const orderAfterExclude = service.segments().map((s) => s.pdfJsId);

    service.includeSegment(segment.pdfJsId);

    const updated = service.segments();
    const included = updated.find((s) => s.pdfJsId === segment.pdfJsId) as TextSegment;
    expect(included.excluded).toBe(false);
    expect(updated.map((s) => s.pdfJsId)).toEqual(orderAfterExclude);
  });

  it('moveSegmentUp should swap a parent segment with the previous parent', () => {
    const segments = service.segments();
    const parentIndex = segments.findIndex((s, i) => i > 0 && s.linkedChildren.length > 0);
    expect(parentIndex).toBeGreaterThan(-1);

    const parent = segments[parentIndex];
    const previousParent = segments[parentIndex - 1];
    const childOrder = parent.linkedChildren.map((c) => c.pdfJsId);

    service.moveSegmentUp(parent.pdfJsId);

    const updated = service.segments();
    expect(updated[parentIndex - 1].pdfJsId).toBe(parent.pdfJsId);
    expect(updated[parentIndex].pdfJsId).toBe(previousParent.pdfJsId);
    expect(updated[parentIndex - 1].linkedChildren.map((c) => c.pdfJsId)).toEqual(childOrder);
  });

  it('moveSegmentUp should throw when moving the first parent segment up', () => {
    const firstParent = service.segments()[0];
    expect(() => service.moveSegmentUp(firstParent.pdfJsId)).toThrow('Cannot move the first segment up.');
  });

  it('moveSegmentUp should promote first child and link previous parent and siblings under it', () => {
    const segments = service.segments();
    const parentIndex = segments.findIndex((s) => s.linkedChildren.length > 0);
    expect(parentIndex).toBeGreaterThan(-1);

    const parent = segments[parentIndex];
    const parentId = parent.pdfJsId;
    const originalChildren = parent.linkedChildren.map((c) => c.pdfJsId);
    const firstChild = parent.linkedChildren[0];

    service.moveSegmentUp(firstChild.pdfJsId);

    const updated = service.segments();
    const promoted = updated[parentIndex];
    expect(promoted.pdfJsId).toBe(firstChild.pdfJsId);
    expect(promoted.linkedChildren.map((c) => c.pdfJsId)).toEqual([parentId, ...originalChildren.slice(1)]);
  });

  it('moveSegmentUp should swap a non-first child with its previous sibling', () => {
    const segments = service.segments();
    const parentIndex = segments.findIndex((s) => s.linkedChildren.length >= 2);
    expect(parentIndex).toBeGreaterThan(-1);

    const parent = segments[parentIndex];
    const parentId = parent.pdfJsId;
    const originalOrder = parent.linkedChildren.map((c) => c.pdfJsId);
    const childToMove = parent.linkedChildren[1];

    service.moveSegmentUp(childToMove.pdfJsId);

    const updatedParent = service.segments().find((s) => s.pdfJsId === parentId) as TextSegment;
    const expectedOrder = [...originalOrder];
    [expectedOrder[0], expectedOrder[1]] = [expectedOrder[1], expectedOrder[0]];
    expect(updatedParent.linkedChildren.map((c) => c.pdfJsId)).toEqual(expectedOrder);
  });

  it('moveSegmentDown should swap a parent segment with the next parent', () => {
    const segments = service.segments();
    const parentIndex = segments.findIndex((_, i) => i < segments.length - 1);
    expect(parentIndex).toBeGreaterThan(-1);

    const parent = segments[parentIndex];
    const nextParent = segments[parentIndex + 1];
    const childOrder = parent.linkedChildren.map((c) => c.pdfJsId);

    service.moveSegmentDown(parent.pdfJsId);

    const updated = service.segments();
    expect(updated[parentIndex].pdfJsId).toBe(nextParent.pdfJsId);
    expect(updated[parentIndex + 1].pdfJsId).toBe(parent.pdfJsId);
    expect(updated[parentIndex + 1].linkedChildren.map((c) => c.pdfJsId)).toEqual(childOrder);
  });

  it('moveSegmentDown should do nothing when moving the last parent segment down', () => {
    const segments = service.segments();
    const lastParent = segments[segments.length - 1];
    const parentOrderBefore = segments.map((s) => s.pdfJsId);

    service.moveSegmentDown(lastParent.pdfJsId);

    expect(service.segments().map((s) => s.pdfJsId)).toEqual(parentOrderBefore);
  });

  it('moveSegmentDown should swap a child with the next sibling when child is not last', () => {
    const segments = service.segments();
    const parentIndex = segments.findIndex((s) => s.linkedChildren.length >= 2);
    expect(parentIndex).toBeGreaterThan(-1);

    const parent = segments[parentIndex];
    const parentId = parent.pdfJsId;
    const originalOrder = parent.linkedChildren.map((c) => c.pdfJsId);
    const childToMove = parent.linkedChildren[0];

    service.moveSegmentDown(childToMove.pdfJsId);

    const updatedParent = service.segments().find((s) => s.pdfJsId === parentId) as TextSegment;
    const expectedOrder = [...originalOrder];
    [expectedOrder[0], expectedOrder[1]] = [expectedOrder[1], expectedOrder[0]];
    expect(updatedParent.linkedChildren.map((c) => c.pdfJsId)).toEqual(expectedOrder);
  });

  it('moveSegmentDown should promote last child to parent segment after the next parent', () => {
    const segments = service.segments();
    const parentIndex = segments.findIndex((s, i) => i < segments.length - 1 && s.linkedChildren.length > 0);
    expect(parentIndex).toBeGreaterThan(-1);

    const parent = segments[parentIndex];
    const parentId = parent.pdfJsId;
    const lastChild = parent.linkedChildren[parent.linkedChildren.length - 1];
    const expectedNextParentId = segments[parentIndex + 1].pdfJsId;
    const remainingChildren = parent.linkedChildren.slice(0, -1).map((c) => c.pdfJsId);

    service.moveSegmentDown(lastChild.pdfJsId);

    const updated = service.segments();
    const updatedParent = updated.find((s) => s.pdfJsId === parentId) as TextSegment;
    expect(updated[parentIndex + 1].pdfJsId).toBe(expectedNextParentId);
    expect(updated[parentIndex + 2].pdfJsId).toBe(lastChild.pdfJsId);
    expect(updatedParent.linkedChildren.map((c) => c.pdfJsId)).toEqual(remainingChildren);
  });

  it('moveSegmentDown should do nothing when moving the last child of the last parent', () => {
    const lastChild: TextSegment = {
      sequentialId: 1,
      pdfJsId: 'c_last',
      page: 1,
      text: 'Child',
      excluded: false,
      linkedChildren: [],
    };
    const lastParent: TextSegment = {
      sequentialId: 0,
      pdfJsId: 'p_last',
      page: 1,
      text: 'Parent',
      excluded: false,
      linkedChildren: [lastChild],
    };
    service.segments.set([lastParent]);

    service.moveSegmentDown('c_last');

    const updated = service.segments();
    expect(updated.length).toBe(1);
    expect(updated[0].linkedChildren.length).toBe(1);
    expect(updated[0].linkedChildren[0].pdfJsId).toBe('c_last');
  });

  it('operations should throw for unknown segment id', () => {
    const invalidId = 'non-existent-segment-id-xyz';
    expect(() => service.toggleSegmentLinking(invalidId)).toThrow('Segment not found.');
    expect(() => service.excludeSegment(invalidId)).toThrow('Segment not found.');
    expect(() => service.includeSegment(invalidId)).toThrow('Segment not found.');
    expect(() => service.moveSegmentUp(invalidId)).toThrow('Segment not found.');
    expect(() => service.moveSegmentDown(invalidId)).toThrow('Segment not found.');
  });

  describe('findParentSegment', () => {
    it('should return null if segment is not found or segments list is empty', () => {
      service.segments.set([]);
      expect(service.findParentSegment('non-existent-id')).toBeNull();

      const singleSegment: TextSegment = {
        sequentialId: 0,
        pdfJsId: 'p1',
        page: 1,
        text: 'Segment 1',
        excluded: false,
        linkedChildren: [],
      };
      service.segments.set([singleSegment]);
      expect(service.findParentSegment('unknown-id')).toBeNull();
    });

    it('should return the parent segment itself when queried with a parent segment id', () => {
      const segments = service.segments();
      const parent = segments[0];

      const result = service.findParentSegment(parent.pdfJsId);
      expect(result).toBe(parent);
    });

    it('should return the enclosing parent segment when queried with a child segment id', () => {
      const segments = service.segments();
      const parentWithChildren = segments.find((s) => s.linkedChildren.length > 0) as TextSegment;
      const child = parentWithChildren.linkedChildren[0];

      const result = service.findParentSegment(child.pdfJsId);
      expect(result).toBe(parentWithChildren);
    });
  });

  describe('nextInFlattenedList', () => {
    it('should return null if segment is not found or segments list is empty', () => {
      service.segments.set([]);
      expect(service.nextInFlattenedList('non-existent-id')).toBeNull();

      const singleSegment: TextSegment = {
        sequentialId: 0,
        pdfJsId: 'p1',
        page: 1,
        text: 'Segment 1',
        excluded: false,
        linkedChildren: [],
      };
      service.segments.set([singleSegment]);
      expect(service.nextInFlattenedList('unknown-id')).toBeNull();
    });

    it('should return the first child of a parent segment when the parent has linked children', () => {
      const child1: TextSegment = {
        sequentialId: 1,
        pdfJsId: 'c1',
        page: 1,
        text: 'Child 1',
        excluded: false,
        linkedChildren: [],
      };
      const child2: TextSegment = {
        sequentialId: 2,
        pdfJsId: 'c2',
        page: 1,
        text: 'Child 2',
        excluded: false,
        linkedChildren: [],
      };
      const parent1: TextSegment = {
        sequentialId: 0,
        pdfJsId: 'p1',
        page: 1,
        text: 'Parent 1',
        excluded: false,
        linkedChildren: [child1, child2],
      };
      service.segments.set([parent1]);

      const result = service.nextInFlattenedList('p1');
      expect(result).toEqual(child1);
    });

    it('should return the next parent segment when a parent segment has no linked children', () => {
      const parent1: TextSegment = {
        sequentialId: 0,
        pdfJsId: 'p1',
        page: 1,
        text: 'Parent 1',
        excluded: false,
        linkedChildren: [],
      };
      const parent2: TextSegment = {
        sequentialId: 1,
        pdfJsId: 'p2',
        page: 1,
        text: 'Parent 2',
        excluded: false,
        linkedChildren: [],
      };
      service.segments.set([parent1, parent2]);

      const result = service.nextInFlattenedList('p1');
      expect(result).toEqual(parent2);
    });

    it('should return null when a parent segment is the last parent and has no linked children', () => {
      const parent1: TextSegment = {
        sequentialId: 0,
        pdfJsId: 'p1',
        page: 1,
        text: 'Parent 1',
        excluded: false,
        linkedChildren: [],
      };
      service.segments.set([parent1]);

      const result = service.nextInFlattenedList('p1');
      expect(result).toBeNull();
    });

    it('should return the next child sibling when a child segment is not the last child', () => {
      const child1: TextSegment = {
        sequentialId: 1,
        pdfJsId: 'c1',
        page: 1,
        text: 'Child 1',
        excluded: false,
        linkedChildren: [],
      };
      const child2: TextSegment = {
        sequentialId: 2,
        pdfJsId: 'c2',
        page: 1,
        text: 'Child 2',
        excluded: false,
        linkedChildren: [],
      };
      const parent1: TextSegment = {
        sequentialId: 0,
        pdfJsId: 'p1',
        page: 1,
        text: 'Parent 1',
        excluded: false,
        linkedChildren: [child1, child2],
      };
      service.segments.set([parent1]);

      const result = service.nextInFlattenedList('c1');
      expect(result).toEqual(child2);
    });

    it('should return the next parent segment when a child segment is the last child of its parent', () => {
      const child1: TextSegment = {
        sequentialId: 1,
        pdfJsId: 'c1',
        page: 1,
        text: 'Child 1',
        excluded: false,
        linkedChildren: [],
      };
      const parent1: TextSegment = {
        sequentialId: 0,
        pdfJsId: 'p1',
        page: 1,
        text: 'Parent 1',
        excluded: false,
        linkedChildren: [child1],
      };
      const parent2: TextSegment = {
        sequentialId: 2,
        pdfJsId: 'p2',
        page: 1,
        text: 'Parent 2',
        excluded: false,
        linkedChildren: [],
      };
      service.segments.set([parent1, parent2]);

      const result = service.nextInFlattenedList('c1');
      expect(result).toEqual(parent2);
    });

    it('should return null when a child segment is the last child of the last parent segment', () => {
      const child1: TextSegment = {
        sequentialId: 1,
        pdfJsId: 'c1',
        page: 1,
        text: 'Child 1',
        excluded: false,
        linkedChildren: [],
      };
      const parent1: TextSegment = {
        sequentialId: 0,
        pdfJsId: 'p1',
        page: 1,
        text: 'Parent 1',
        excluded: false,
        linkedChildren: [child1],
      };
      service.segments.set([parent1]);

      const result = service.nextInFlattenedList('c1');
      expect(result).toBeNull();
    });

    it('should traverse sequentially across multiple parents and children in flattened order', () => {
      const c1_1: TextSegment = {
        sequentialId: 1,
        pdfJsId: 'c1_1',
        page: 1,
        text: 'C1_1',
        excluded: false,
        linkedChildren: [],
      };
      const c1_2: TextSegment = {
        sequentialId: 2,
        pdfJsId: 'c1_2',
        page: 1,
        text: 'C1_2',
        excluded: false,
        linkedChildren: [],
      };
      const p1: TextSegment = {
        sequentialId: 0,
        pdfJsId: 'p1',
        page: 1,
        text: 'P1',
        excluded: false,
        linkedChildren: [c1_1, c1_2],
      };
      const p2: TextSegment = {
        sequentialId: 3,
        pdfJsId: 'p2',
        page: 1,
        text: 'P2',
        excluded: false,
        linkedChildren: [],
      };
      const c3_1: TextSegment = {
        sequentialId: 5,
        pdfJsId: 'c3_1',
        page: 1,
        text: 'C3_1',
        excluded: false,
        linkedChildren: [],
      };
      const p3: TextSegment = {
        sequentialId: 4,
        pdfJsId: 'p3',
        page: 1,
        text: 'P3',
        excluded: false,
        linkedChildren: [c3_1],
      };
      service.segments.set([p1, p2, p3]);

      expect(service.nextInFlattenedList('p1')?.pdfJsId).toBe('c1_1');
      expect(service.nextInFlattenedList('c1_1')?.pdfJsId).toBe('c1_2');
      expect(service.nextInFlattenedList('c1_2')?.pdfJsId).toBe('p2');
      expect(service.nextInFlattenedList('p2')?.pdfJsId).toBe('p3');
      expect(service.nextInFlattenedList('p3')?.pdfJsId).toBe('c3_1');
      expect(service.nextInFlattenedList('c3_1')).toBeNull();
    });
  });

  describe('previousInFlattenedList', () => {
    it('should return null if segment is not found or segments list is empty', () => {
      service.segments.set([]);
      expect(service.previousInFlattenedList('non-existent-id')).toBeNull();

      const singleSegment: TextSegment = {
        sequentialId: 0,
        pdfJsId: 'p1',
        page: 1,
        text: 'Segment 1',
        excluded: false,
        linkedChildren: [],
      };
      service.segments.set([singleSegment]);
      expect(service.previousInFlattenedList('unknown-id')).toBeNull();
    });

    it('should return null if the segment is the first parent in the list', () => {
      const parent1: TextSegment = {
        sequentialId: 0,
        pdfJsId: 'p1',
        page: 1,
        text: 'Parent 1',
        excluded: false,
        linkedChildren: [],
      };
      const parent2: TextSegment = {
        sequentialId: 1,
        pdfJsId: 'p2',
        page: 1,
        text: 'Parent 2',
        excluded: false,
        linkedChildren: [],
      };
      service.segments.set([parent1, parent2]);

      const result = service.previousInFlattenedList('p1');
      expect(result).toBeNull();
    });

    it('should return the previous parent segment if the previous parent has no linked children', () => {
      const parent1: TextSegment = {
        sequentialId: 0,
        pdfJsId: 'p1',
        page: 1,
        text: 'Parent 1',
        excluded: false,
        linkedChildren: [],
      };
      const parent2: TextSegment = {
        sequentialId: 1,
        pdfJsId: 'p2',
        page: 1,
        text: 'Parent 2',
        excluded: false,
        linkedChildren: [],
      };
      service.segments.set([parent1, parent2]);

      const result = service.previousInFlattenedList('p2');
      expect(result).toEqual(parent1);
    });

    it('should return the last child of the previous parent if the previous parent has linked children', () => {
      const child1: TextSegment = {
        sequentialId: 1,
        pdfJsId: 'c1',
        page: 1,
        text: 'Child 1',
        excluded: false,
        linkedChildren: [],
      };
      const child2: TextSegment = {
        sequentialId: 2,
        pdfJsId: 'c2',
        page: 1,
        text: 'Child 2',
        excluded: false,
        linkedChildren: [],
      };
      const parent1: TextSegment = {
        sequentialId: 0,
        pdfJsId: 'p1',
        page: 1,
        text: 'Parent 1',
        excluded: false,
        linkedChildren: [child1, child2],
      };
      const parent2: TextSegment = {
        sequentialId: 3,
        pdfJsId: 'p2',
        page: 1,
        text: 'Parent 2',
        excluded: false,
        linkedChildren: [],
      };
      service.segments.set([parent1, parent2]);

      const result = service.previousInFlattenedList('p2');
      expect(result).toEqual(child2);
    });

    it('should return the parent segment if the segment is the first child of its parent', () => {
      const child1: TextSegment = {
        sequentialId: 1,
        pdfJsId: 'c1',
        page: 1,
        text: 'Child 1',
        excluded: false,
        linkedChildren: [],
      };
      const parent1: TextSegment = {
        sequentialId: 0,
        pdfJsId: 'p1',
        page: 1,
        text: 'Parent 1',
        excluded: false,
        linkedChildren: [child1],
      };
      service.segments.set([parent1]);

      const result = service.previousInFlattenedList('c1');
      expect(result).toEqual(parent1);
    });

    it('should return the previous child sibling if the segment is not the first child', () => {
      const child1: TextSegment = {
        sequentialId: 1,
        pdfJsId: 'c1',
        page: 1,
        text: 'Child 1',
        excluded: false,
        linkedChildren: [],
      };
      const child2: TextSegment = {
        sequentialId: 2,
        pdfJsId: 'c2',
        page: 1,
        text: 'Child 2',
        excluded: false,
        linkedChildren: [],
      };
      const parent1: TextSegment = {
        sequentialId: 0,
        pdfJsId: 'p1',
        page: 1,
        text: 'Parent 1',
        excluded: false,
        linkedChildren: [child1, child2],
      };
      service.segments.set([parent1]);

      const result = service.previousInFlattenedList('c2');
      expect(result).toEqual(child1);
    });

    it('should traverse backwards sequentially across multiple parents and children in flattened order', () => {
      const c1_1: TextSegment = {
        sequentialId: 1,
        pdfJsId: 'c1_1',
        page: 1,
        text: 'C1_1',
        excluded: false,
        linkedChildren: [],
      };
      const c1_2: TextSegment = {
        sequentialId: 2,
        pdfJsId: 'c1_2',
        page: 1,
        text: 'C1_2',
        excluded: false,
        linkedChildren: [],
      };
      const p1: TextSegment = {
        sequentialId: 0,
        pdfJsId: 'p1',
        page: 1,
        text: 'P1',
        excluded: false,
        linkedChildren: [c1_1, c1_2],
      };
      const p2: TextSegment = {
        sequentialId: 3,
        pdfJsId: 'p2',
        page: 1,
        text: 'P2',
        excluded: false,
        linkedChildren: [],
      };
      const c3_1: TextSegment = {
        sequentialId: 5,
        pdfJsId: 'c3_1',
        page: 1,
        text: 'C3_1',
        excluded: false,
        linkedChildren: [],
      };
      const p3: TextSegment = {
        sequentialId: 4,
        pdfJsId: 'p3',
        page: 1,
        text: 'P3',
        excluded: false,
        linkedChildren: [c3_1],
      };
      service.segments.set([p1, p2, p3]);

      expect(service.previousInFlattenedList('c3_1')?.pdfJsId).toBe('p3');
      expect(service.previousInFlattenedList('p3')?.pdfJsId).toBe('p2');
      expect(service.previousInFlattenedList('p2')?.pdfJsId).toBe('c1_2');
      expect(service.previousInFlattenedList('c1_2')?.pdfJsId).toBe('c1_1');
      expect(service.previousInFlattenedList('c1_1')?.pdfJsId).toBe('p1');
      expect(service.previousInFlattenedList('p1')).toBeNull();
    });
  });

  describe('segmentText and status', () => {
    it('workUpcoming should set status to loading', () => {
      service.workUpcoming();
      expect(service.status()).toBe('loading');
    });

    it('segmentText should parse marked content and text items across pages', () => {
      service.segments.set([]);
      const mockPage1 = {
        items: [
          { type: 'beginMarkedContentProps', id: 'mc_p1_1' },
          { str: 'Hello' },
          { str: 'World' },
          { type: 'endMarkedContent' },
          { type: 'beginMarkedContent' },
          { str: 'Ignored text' },
          { type: 'endMarkedContent' },
          { type: 'beginMarkedContentProps', id: 'mc_p1_empty' },
          { str: '   ' },
          { type: 'endMarkedContent' },
          { type: 'beginMarkedContentProps', id: 'mc_p1_2' },
          { str: 'Page 1 paragraph 2' },
          { type: 'endMarkedContent' },
        ]
      };

      const mockPage2 = {
        items: [
          { type: 'beginMarkedContentProps', id: 'mc_p2_1' },
          { str: 'Page 2 content' },
          { type: 'endMarkedContent' },
        ]
      };

      service.segmentText([mockPage1 as TextContent, mockPage2 as TextContent]);

      expect(service.status()).toBe('success');
      const segments = service.segments();
      expect(segments.length).toBe(3);

      expect(segments[0]).toEqual({
        sequentialId: 0,
        pdfJsId: 'mc_p1_1',
        page: 1,
        text: 'Hello World ',
        excluded: false,
        linkedChildren: [],
      });

      expect(segments[1].pdfJsId).toBe('mc_p1_2');
      expect(segments[1].page).toBe(1);

      expect(segments[2].pdfJsId).toBe('mc_p2_1');
      expect(segments[2].page).toBe(2);

      expect(service.isMarkedContentAnAddressableSegment('mc_p1_1')).toBe(true);
      expect(service.isMarkedContentAnAddressableSegment('mc_p1_2')).toBe(true);
      expect(service.isMarkedContentAnAddressableSegment('mc_p2_1')).toBe(true);
      expect(service.isMarkedContentAnAddressableSegment('non_existent')).toBe(false);
    });

    it('segmentText should strip trailing space before space-excluded characters', () => {
      service.segments.set([]);
      const mockPage = {
        items: [
          { type: 'beginMarkedContentProps', id: 'mc_punct_1' },
          { str: 'Hello' },
          { str: '.' },
          { str: 'How' },
          { str: 'are' },
          { str: 'you' },
          { str: '?' },
          { type: 'endMarkedContent' },
        ]
      };

      service.segmentText([mockPage as TextContent]);

      const segments = service.segments();
      expect(segments.length).toBe(1);
      expect(segments[0].text).toBe('Hello. How are you? ');
    });

    it('segmentText should recover and overwrite previous segments when called again', () => {
      const mockPage = {
        items: [
          { type: 'beginMarkedContentProps', id: 'mc_new_1' },
          { str: 'New text' },
          { type: 'endMarkedContent' },
        ]
      };

      expect(service.segments().length).toBeGreaterThan(0);

      service.segmentText([mockPage as TextContent]);

      expect(service.status()).toBe('success');
      const segments = service.segments();
      expect(segments.length).toBe(1);
      expect(segments[0].pdfJsId).toBe('mc_new_1');
      expect(segments[0].sequentialId).toBe(0);
      expect(service.isMarkedContentAnAddressableSegment('mc_new_1')).toBe(true);
    });
  });

  describe('restoreSegments', () => {
    it('should restore segment hierarchy, rebuild addressable segments, and update status', () => {
      const child: TextSegment = {
        sequentialId: 1,
        pdfJsId: 'c1',
        page: 1,
        text: 'Child',
        excluded: false,
        linkedChildren: [],
      };
      const parent: TextSegment = {
        sequentialId: 0,
        pdfJsId: 'p1',
        page: 1,
        text: 'Parent',
        excluded: false,
        linkedChildren: [child],
      };

      service.restoreSegments([parent]);

      expect(service.segments().length).toBe(1);
      expect(service.segments()[0].linkedChildren.length).toBe(1);
      expect(service.isMarkedContentAnAddressableSegment('p1')).toBe(true);
      expect(service.isMarkedContentAnAddressableSegment('c1')).toBe(true);
      expect(service.status()).toBe('success');

      service.restoreSegments([]);
      expect(service.segments().length).toBe(0);
      expect(service.status()).toBe('idle');
      expect(service.isMarkedContentAnAddressableSegment('p1')).toBe(false);
    });
  });
});
