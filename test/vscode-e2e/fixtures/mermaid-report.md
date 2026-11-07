# Mermaid report fixture

Synthetic content for Task 705. Every diagram asks for the ELK layout.

## Flowchart

```mermaid
---
config:
  layout: elk
  htmlLabels: false
---
flowchart TD
  A[Start] --> B[End]
```

## Class diagram, straight edge with cardinalities

```mermaid
---
config:
  layout: elk
  htmlLabels: false
---
classDiagram
  direction TB
  class Owner {
    +Text name
  }
  class Item {
    +Integer count
  }
  Owner "1" --> "*" Item
```

## Class diagram, fan-out

```mermaid
---
config:
  layout: elk
  htmlLabels: false
---
classDiagram
  direction TB
  class Owner {
    +Text name
  }
  class Left
  class Right
  class Middle
  Owner "1" --> "*" Left
  Owner "1" --> "*" Right
  Owner --> Middle
```

## State diagram

```mermaid
---
config:
  layout: elk
  htmlLabels: false
---
stateDiagram-v2
  [*] --> Idle
  Idle --> Busy
  Busy --> [*]
```

## Broken block

```mermaid
this is not a mermaid diagram
```
