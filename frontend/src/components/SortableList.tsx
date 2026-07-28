import React from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

/**
 * Reusable vertical drag-and-drop list wrapper backed by @dnd-kit.
 *
 * Each item is rendered via `renderItem(item, idx, handle)` where `handle`
 * is a pre-styled, drag-activator JSX node. Place that handle wherever it
 * makes sense for your row (usually first cell). Only the handle drags —
 * the surrounding row keeps its normal click/focus/keyboard behavior so
 * inputs and textareas still work.
 */
export function SortableList<T>({
  items,
  getId,
  onReorder,
  renderItem,
}: {
  items: T[];
  getId: (item: T, idx: number) => string | number;
  onReorder: (next: T[]) => void;
  renderItem: (item: T, idx: number, handle: React.ReactNode) => React.ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      // Require a tiny drag distance so plain clicks on inputs/buttons inside
      // the row are not interpreted as drags.
      activationConstraint: { distance: 4 },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const ids: UniqueIdentifier[] = items.map((item, idx) => getId(item, idx));

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = ids.indexOf(active.id);
    const newIndex = ids.indexOf(over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    onReorder(arrayMove(items, oldIndex, newIndex));
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {items.map((item, idx) => (
          <SortableRow key={ids[idx]} id={ids[idx]}>
            {(handle) => renderItem(item, idx, handle)}
          </SortableRow>
        ))}
      </SortableContext>
    </DndContext>
  );
}

/**
 * Internal row wrapper. Hooks up `useSortable` and exposes a pre-bound
 * `handle` JSX node to the caller via render-prop so the caller controls
 * where the handle sits in the row layout.
 */
function SortableRow({
  id,
  children,
}: {
  id: UniqueIdentifier;
  children: (handle: React.ReactNode) => React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const handle = (
    <button
      type="button"
      ref={setActivatorNodeRef}
      {...attributes}
      {...listeners}
      aria-label="Drag to reorder"
      className="flex items-center justify-center w-6 h-6 text-brand-lightgray hover:text-brand-gray cursor-grab active:cursor-grabbing focus:outline-none focus:text-brand-gray touch-none"
    >
      <GripVerticalIcon />
    </button>
  );

  return (
    <div ref={setNodeRef} style={style}>
      {children(handle)}
    </div>
  );
}

/**
 * Standalone drag-handle icon for callers that want to render their own
 * handle outside the SortableList wrapper (rare — usually you'll use the
 * one passed into renderItem).
 */
export function DragHandle() {
  return (
    <span className="flex items-center justify-center w-6 h-6 text-brand-lightgray">
      <GripVerticalIcon />
    </span>
  );
}

/** Small 6-dot grip icon (2 cols × 3 rows). */
function GripVerticalIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="currentColor"
      aria-hidden="true"
    >
      <circle cx="5" cy="3" r="1.2" />
      <circle cx="9" cy="3" r="1.2" />
      <circle cx="5" cy="7" r="1.2" />
      <circle cx="9" cy="7" r="1.2" />
      <circle cx="5" cy="11" r="1.2" />
      <circle cx="9" cy="11" r="1.2" />
    </svg>
  );
}
