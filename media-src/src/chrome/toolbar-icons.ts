// Inline SVG icon strings for toolbar.ts's custom toolbar items (task 470 —
// extracted out of toolbar.ts for organization; values unchanged).

// Toolbar icons restyled to VS Code codicons (task 44). Codicon artwork is CC BY 4.0 (its code is
// MIT; notice in media/codicons.LICENSE); these <path> data are lifted from the codicon source. The matching toolbar
// title-bar buttons use the same codicon names ($(go-to-file)/$(settings-gear)).
export const editInVsCodeIcon =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M8.58594 1.00098C8.98394 1.00098 9.36646 1.15943 9.64746 1.44043L12.5605 4.35352C12.8415 4.63552 13.001 5.01704 13.001 5.41504V13.001C13.001 14.106 12.106 15.001 11.001 15.001H5.00098C3.89599 15.001 3.00098 14.106 3.00098 13.001V6.00098H4.00098V13.001C4.00098 13.553 4.44899 14.001 5.00098 14.001H11.001C11.553 14.001 12.001 13.553 12.001 13.001V6.00098H9.50098C8.67299 6.00096 8.00098 5.32897 8.00098 4.50098V2.00098C7.99198 1.97699 7.98265 1.9527 7.97266 1.92871C7.89674 1.74704 7.78717 1.5812 7.64746 1.44238L7.20605 1.00098H8.58594ZM9 4.5C9 4.776 9.224 5 9.5 5H11.793L9 2.20703V4.5Z"/><path fill="currentColor" d="M4.5 0C4.63299 0 4.75952 0.0534683 4.85352 0.147461L6.85352 2.14746C6.90042 2.19336 6.93789 2.24775 6.96289 2.30859C6.98789 2.36959 7.00097 2.43498 7.00098 2.50098C7.00098 2.56698 6.98789 2.63236 6.96289 2.69336C6.93789 2.75323 6.90043 2.80956 6.85352 2.85547L4.85352 4.85547C4.75956 4.94917 4.63278 5.00195 4.5 5.00195C4.36722 5.00195 4.24044 4.94917 4.14648 4.85547C4.05248 4.76147 3.99902 4.63398 3.99902 4.50098C3.99903 4.36799 4.05249 4.24146 4.14648 4.14746L5.29297 3.00098H2.5C2.10201 3.00098 1.72045 3.15944 1.43945 3.44043C1.15846 3.72242 1.00001 4.10298 1 4.50098V5.50098C1 5.63398 0.947516 5.76147 0.853516 5.85547C0.759563 5.94817 0.632774 6.00098 0.5 6.00098C0.367225 6.00098 0.240437 5.94917 0.146484 5.85547C0.0534844 5.76147 0 5.63398 0 5.50098V4.50098C6.17892e-06 3.83799 0.263427 3.20239 0.732422 2.7334C1.20142 2.26441 1.83701 2.00098 2.5 2.00098H5.29297L4.14648 0.855469C4.05248 0.761469 3.99902 0.633977 3.99902 0.500977C3.99903 0.367985 4.05249 0.241455 4.14648 0.147461C4.24048 0.0534683 4.36701 0 4.5 0Z"/></svg>'

// Task 642 — Tabler `file` with Tabler's letter W drawn in the page body (composed; MIT).
export const wikiPagesIcon =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2" /><path d="M8.5 11.5l1.25 5.5l2.25 -4l2.25 4l1.25 -5.5" /></svg>'

export const backIcon =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path fill="currentColor" d="M13.5 8.00023H3.70701L7.85301 3.85423C8.04801 3.65923 8.04801 3.34223 7.85301 3.14723C7.65801 2.95223 7.34101 2.95223 7.14601 3.14723L2.14601 8.14723C1.95101 8.34223 1.95101 8.65923 2.14601 8.85423L7.14601 13.8542C7.24401 13.9522 7.37201 14.0002 7.50001 14.0002C7.62801 14.0002 7.75601 13.9512 7.85401 13.8542C8.04901 13.6592 8.04901 13.3422 7.85401 13.1472L3.70801 9.00123H13.501C13.777 9.00123 14.001 8.77723 14.001 8.50123C14.001 8.22523 13.777 8.00123 13.501 8.00123L13.5 8.00023Z"/></svg>'

// Outline / table-of-contents: a top-level bullet with a long rule plus two indented
// bullets with shorter rules — reads as a document structure, distinct from the flat
// "list" toolbar icon. All custom toolbar icons declare the same 16×16 viewport.
export const outlineIcon =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path fill="currentColor" d="M2 2.25a1 1 0 100 2 1 1 0 000-2zM5 2.5a.75.75 0 000 1.5h9a.75.75 0 000-1.5H5zM4 7a1 1 0 100 2 1 1 0 000-2zM7 7.25a.75.75 0 000 1.5h7a.75.75 0 000-1.5H7zM4 11.75a1 1 0 100 2 1 1 0 000-2zM7 12a.75.75 0 000 1.5h7a.75.75 0 000-1.5H7z"/></svg>'

// Vditor's generated sprite does not contain `vditor-icon-more`, so keep the
// overflow trigger self-contained and unmistakable.
export const moreIcon =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" width="16" height="16" aria-hidden="true"><circle fill="currentColor" cx="3" cy="8" r="1.25"/><circle fill="currentColor" cx="8" cy="8" r="1.25"/><circle fill="currentColor" cx="13" cy="8" r="1.25"/></svg>'

// Reuses Vditor's own bundled sprite (#vditor-icon-link), not a raw <path> — kept
// here alongside the others so every toolbar icon reference lives in one module.
export const linkIcon =
  '<svg viewBox="0 0 16 16" width="16" height="16"><use xlink:href="#vditor-icon-link"></use></svg>'

export const calloutIcon =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M2 2.5A1.5 1.5 0 0 1 3.5 1h9A1.5 1.5 0 0 1 14 2.5v7a1.5 1.5 0 0 1-1.5 1.5H7l-3.4 3.1A.5.5 0 0 1 2.75 13.7V11A1.5 1.5 0 0 1 2 9.5v-7ZM3.5 2a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5h.25v2.57L6.61 10H12.5a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.5-.5h-9ZM7.5 3.5h1v3h-1v-3Zm0 4h1v1h-1v-1Z"/></svg>'

export const detailsIcon =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M2 2h12v12H2V2Zm1 1v10h10V3H3Zm1.5 2 2 2-2 2V5Zm3.5.5h3v1H8v-1Zm0 3h3v1H8v-1Z"/></svg>'

export const subscriptIcon =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M2 3h1.7l2.3 3.1L8.3 3H10L6.9 7.1 10.2 13H8.5L6 8.5 3.5 13H1.8l3.3-5.9L2 3Zm9.2 6.5c.5-.5 1.1-.8 1.9-.8 1.1 0 1.9.6 1.9 1.7 0 .7-.4 1.2-1 1.7l-1.1.8H15V14h-3.8v-1c0-.5.3-1 .8-1.4l1.2-.9c.3-.2.4-.4.4-.6 0-.3-.2-.5-.6-.5-.4 0-.8.2-1.2.6l-.9-.7Z"/></svg>'

// A compact summation mark keeps Math identifiable beside the other 16px toolbar icons.
export const mathIcon =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M3 2h10v2H6l4 4-4 4h7v2H3v-2l4-4-4-4V2Z"/></svg>'

export const underlineIcon =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M4 2h1v5.5a3 3 0 0 0 6 0V2h1v5.5a4 4 0 0 1-8 0V2Zm-1 11h10v1H3v-1Z"/></svg>'

export const superscriptIcon =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M2 3h1.7l2.3 3.1L8.3 3H10L6.9 7.1 10.2 13H8.5L6 8.5 3.5 13H1.8l3.3-5.9Zm9.2-1.8c.5-.5 1.1-.8 1.9-.8 1.1 0 1.9.6 1.9 1.7 0 .7-.4 1.2-1 1.7l-1.1.8H15V5.7h-3.8v-1c0-.5.3-1 .8-1.4l1.2-.9c.3-.2.4-.4.4-.6 0-.3-.2-.5-.6-.5-.4 0-.8.2-1.2.6l-.9-.7Z"/></svg>'

// Task 631 — collapse/expand toggle chevrons (codicon chevron-up / chevron-down paths, MIT).
// The icon shows the current state's action target: up while the toolbar is expanded (click to
// collapse), down while collapsed (click to expand).
export const chevronUpIcon =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M3.147 10.354a.5.5 0 0 0 .707 0L8 6.207l4.146 4.147a.5.5 0 0 0 .707-.707l-4.5-4.5a.5.5 0 0 0-.707 0l-4.5 4.5a.5.5 0 0 0 0 .707Z"/></svg>'

export const chevronDownIcon =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M3.147 5.647a.5.5 0 0 1 .707 0L8 9.793l4.146-4.146a.5.5 0 0 1 .707.707l-4.5 4.5a.5.5 0 0 1-.707 0l-4.5-4.5a.5.5 0 0 1 0-.707Z"/></svg>'

// Task 642 — approved icons, each copied unmodified from its upstream source file (Tabler and Lucide
// are 24x24 stroke icons: their viewBox and stroke attributes stay, and the toolbar CSS keeps them
// drawn as strokes). Notices: media/codicons.LICENSE, media/tabler-icons.LICENSE, media/lucide.LICENSE.

// Codicons `preview` (CC BY 4.0, media/codicons.LICENSE).
export const previewIcon =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M12.5 1H3.5C2.122 1 1 2.122 1 3.5V12.5C1 13.878 2.122 15 3.5 15H12.5C13.878 15 15 13.878 15 12.5V3.5C15 2.122 13.878 1 12.5 1ZM14 12.5C14 13.327 13.327 14 12.5 14H3.5C2.673 14 2 13.327 2 12.5V3.5C2 2.673 2.673 2 3.5 2H12.5C13.327 2 14 2.673 14 3.5V12.5ZM11 4H5C4.448 4 4 4.448 4 5V7C4 7.552 4.448 8 5 8H11C11.552 8 12 7.552 12 7V5C12 4.448 11.552 4 11 4ZM11 7H5V5H11V7ZM11 9H10C9.448 9 9 9.448 9 10V11C9 11.552 9.448 12 10 12H11C11.552 12 12 11.552 12 11V10C12 9.448 11.552 9 11 9ZM11 11H10V10H11V11ZM8 9.5C8 9.776 7.776 10 7.5 10H4.5C4.224 10 4 9.776 4 9.5C4 9.224 4.224 9 4.5 9H7.5C7.776 9 8 9.224 8 9.5ZM8 11.5C8 11.776 7.776 12 7.5 12H4.5C4.224 12 4 11.776 4 11.5C4 11.224 4.224 11 4.5 11H7.5C7.776 11 8 11.224 8 11.5Z"/></svg>'

// Codicons `settings-gear` (CC BY 4.0), 24x24 viewBox as published.
export const settingsGearIcon =
  '<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M12 9C10.3425 9 9.00002 10.3425 9.00002 12C9.00002 13.6575 10.3425 15 12 15C13.6575 15 15 13.6575 15 12C15 10.3425 13.6575 9 12 9ZM12 13.5C11.172 13.5 10.5 12.828 10.5 12C10.5 11.172 11.172 10.5 12 10.5C12.828 10.5 13.5 11.172 13.5 12C13.5 12.828 12.828 13.5 12 13.5ZM21.8475 14.5725L19.9185 12.942C19.8675 12.8985 19.8195 12.8505 19.776 12.7995C19.332 12.279 19.3965 11.5005 19.9185 11.058L21.8475 9.4275C22.0395 9.2655 22.113 9.0045 22.0365 8.766C21.579 7.3545 20.823 6.06 19.8285 4.962C19.7085 4.83 19.5405 4.758 19.368 4.758C19.2975 4.758 19.227 4.77 19.1595 4.794L16.779 5.6415C16.716 5.664 16.65 5.682 16.584 5.694C16.509 5.7075 16.434 5.715 16.3605 5.715C15.7725 5.715 15.2505 5.298 15.141 4.701L14.6865 2.223C14.6415 1.977 14.451 1.782 14.205 1.7295C13.485 1.5765 12.7485 1.5 12.0015 1.5C11.2545 1.5 10.5165 1.578 9.79652 1.7295C9.55052 1.782 9.36002 1.977 9.31502 2.223L8.86202 4.701C8.85002 4.767 8.83202 4.8315 8.80952 4.8945C8.62802 5.4 8.15102 5.715 7.64102 5.715C7.50302 5.715 7.36202 5.691 7.22402 5.643L4.84352 4.7955C4.77602 4.7715 4.70402 4.7595 4.63502 4.7595C4.46252 4.7595 4.29452 4.8315 4.17452 4.9635C3.17852 6.0615 2.42402 7.356 1.96502 8.7675C1.88702 9.006 1.96202 9.267 2.15402 9.429L4.08302 11.0595C4.13402 11.103 4.18202 11.151 4.22552 11.202C4.66952 11.7225 4.60502 12.501 4.08302 12.9435L2.15402 14.574C1.96202 14.736 1.88852 14.997 1.96502 15.2355C2.42252 16.647 3.17852 17.9415 4.17452 19.0395C4.29452 19.1715 4.46252 19.2435 4.63502 19.2435C4.70552 19.2435 4.77602 19.2315 4.84352 19.2075L7.22402 18.36C7.28702 18.3375 7.35302 18.3195 7.41902 18.3075C7.49402 18.294 7.56902 18.288 7.64252 18.288C8.23052 18.288 8.75252 18.705 8.86202 19.302L9.31502 21.78C9.36002 22.026 9.55052 22.221 9.79652 22.2735C10.5165 22.4265 11.2545 22.503 12.0015 22.503C12.7485 22.503 13.4865 22.425 14.205 22.2735C14.451 22.221 14.6415 22.026 14.6865 21.78L15.141 19.302C15.153 19.236 15.171 19.1715 15.1935 19.1085C15.375 18.603 15.852 18.288 16.362 18.288C16.5 18.288 16.641 18.312 16.779 18.36L19.158 19.2075C19.227 19.2315 19.2975 19.2435 19.3665 19.2435C19.539 19.2435 19.707 19.1715 19.827 19.0395C20.823 17.9415 21.5775 16.647 22.035 15.2355C22.113 14.997 22.038 14.736 21.846 14.574L21.8475 14.5725ZM19.092 17.589L17.2815 16.944C16.9845 16.839 16.6755 16.785 16.362 16.785C15.2085 16.785 14.1705 17.514 13.782 18.5985C13.731 18.738 13.6935 18.882 13.6665 19.029L13.3215 20.9055C12.8865 20.9685 12.444 21 12.0015 21C11.559 21 11.1165 20.9685 10.68 20.904L10.3365 19.0275C10.098 17.727 8.96552 16.7835 7.64252 16.7835C7.48052 16.7835 7.31552 16.7985 7.14902 16.8285C7.00352 16.8555 6.86102 16.893 6.72002 16.9425L4.90952 17.5875C4.35752 16.896 3.91652 16.1385 3.59102 15.321L5.05202 14.0865C5.61152 13.614 5.95202 12.951 6.01202 12.222C6.07202 11.493 5.84252 10.785 5.36702 10.227C5.27102 10.1145 5.16452 10.008 5.05202 9.912L3.59102 8.6775C3.91652 7.86 4.35752 7.101 4.90952 6.411L6.72002 7.056C7.01702 7.161 7.32602 7.215 7.64102 7.215C8.79452 7.215 9.83252 6.486 10.221 5.4015C10.272 5.2605 10.3095 5.1165 10.3365 4.971L10.68 3.0945C11.1165 3.0315 11.559 2.9985 12.0015 2.9985C12.444 2.9985 12.8865 3.03 13.3215 3.093L13.665 4.9695C13.9035 6.27 15.036 7.2135 16.359 7.2135C16.521 7.2135 16.686 7.1985 16.851 7.1685C16.9965 7.1415 17.1405 7.104 17.2815 7.0545L19.092 6.4095C19.644 7.0995 20.085 7.8585 20.4105 8.676L18.951 9.9105C18.3915 10.383 18.0495 11.046 17.991 11.775C17.931 12.504 18.1605 13.2135 18.636 13.77C18.7335 13.884 18.8385 13.989 18.9525 14.085L20.4135 15.3195C20.088 16.137 19.647 16.896 19.095 17.586L19.092 17.589Z"/></svg>'

// Codicons `split-horizontal` (CC BY 4.0).
export const splitHorizontalIcon =
  '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M12.5 1H3.5C2.122 1 1 2.122 1 3.5V12.5C1 13.878 2.122 15 3.5 15H12.5C13.878 15 15 13.878 15 12.5V3.5C15 2.122 13.878 1 12.5 1ZM2 12.5V3.5C2 2.673 2.673 2 3.5 2H7.5V14H3.5C2.673 14 2 13.327 2 12.5ZM14 12.5C14 13.327 13.327 14 12.5 14H8.5V2H12.5C13.327 2 14 2.673 14 3.5V12.5Z"/></svg>'

// Codicons `file-media` (CC BY 4.0).
export const fileMediaIcon =
  '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M6 1C4.89543 1 4 1.89543 4 3V6H5V3C5 2.44772 5.44772 2 6 2H9V4.5C9 5.32843 9.67157 6 10.5 6H13V13C13 13.5523 12.5523 14 12 14H10.9646C10.9141 14.3531 10.8109 14.6891 10.6632 15H12C13.1046 15 14 14.1046 14 13V5.41421C14 5.01639 13.842 4.63486 13.5607 4.35355L10.6464 1.43934C10.3651 1.15804 9.98361 1 9.58579 1H6ZM12.7929 5H10.5C10.2239 5 10 4.77614 10 4.5V2.20711L12.7929 5ZM1 9.5C1 8.11929 2.11929 7 3.5 7H7.5C8.88071 7 10 8.11929 10 9.5V13.5C10 14.0095 9.84756 14.4835 9.5858 14.8787L6.56066 11.8536C5.97487 11.2678 5.02513 11.2678 4.43934 11.8536L1.4142 14.8787C1.15244 14.4835 1 14.0095 1 13.5V9.5ZM8 9.75C8 9.33579 7.66421 9 7.25 9C6.83579 9 6.5 9.33579 6.5 9.75C6.5 10.1642 6.83579 10.5 7.25 10.5C7.66421 10.5 8 10.1642 8 9.75ZM2.12131 15.5858C2.51652 15.8476 2.99046 16 3.5 16H7.5C8.00954 16 8.48348 15.8476 8.87869 15.5858L5.85355 12.5607C5.65829 12.3654 5.34171 12.3654 5.14645 12.5607L2.12131 15.5858Z"/></svg>'

// Codicons `info` (CC BY 4.0).
export const infoIcon =
  '<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M8.49902 7.49998C8.49902 7.22384 8.27517 6.99998 7.99902 6.99998C7.72288 6.99998 7.49902 7.22384 7.49902 7.49998V10.5C7.49902 10.7761 7.72288 11 7.99902 11C8.27517 11 8.49902 10.7761 8.49902 10.5V7.49998ZM8.74807 5.50001C8.74807 5.91369 8.41271 6.24905 7.99903 6.24905C7.58535 6.24905 7.25 5.91369 7.25 5.50001C7.25 5.08633 7.58535 4.75098 7.99903 4.75098C8.41271 4.75098 8.74807 5.08633 8.74807 5.50001ZM8 1C4.13401 1 1 4.13401 1 8C1 11.866 4.13401 15 8 15C11.866 15 15 11.866 15 8C15 4.13401 11.866 1 8 1ZM2 8C2 4.68629 4.68629 2 8 2C11.3137 2 14 4.68629 14 8C14 11.3137 11.3137 14 8 14C4.68629 14 2 11.3137 2 8Z"/></svg>'

// Lucide `sigma` (ISC, media/lucide.LICENSE).
export const sigmaIcon =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 7V5a1 1 0 0 0-1-1H6.5a.5.5 0 0 0-.4.8l4.5 6a2 2 0 0 1 0 2.4l-4.5 6a.5.5 0 0 0 .4.8H17a1 1 0 0 0 1-1v-2" /></svg>'

// Lucide `square-sigma` (ISC).
export const squareSigmaIcon =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M16 8.9V7H8l4 5-4 5h8v-1.9" /></svg>'

// Lucide `square-pen` (ISC).
export const squarePenIcon =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" /></svg>'

// Tabler `heading` (MIT, media/tabler-icons.LICENSE).
export const headingIcon =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 12h10" /><path d="M7 5v14" /><path d="M17 5v14" /><path d="M15 19h4" /><path d="M15 5h4" /><path d="M5 19h4" /><path d="M5 5h4" /></svg>'

// Tabler `row-insert-top` (MIT).
export const rowInsertTopIcon =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 18v-4a1 1 0 0 1 1 -1h14a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-14a1 1 0 0 1 -1 -1" /><path d="M12 9v-4" /><path d="M10 7l4 0" /></svg>'

// Tabler `row-insert-bottom` (MIT).
export const rowInsertBottomIcon =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6v4a1 1 0 0 1 -1 1h-14a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1h14a1 1 0 0 1 1 1" /><path d="M12 15l0 4" /><path d="M14 17l-4 0" /></svg>'

// Tabler `hash` (MIT).
export const hashIcon =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 9l14 0" /><path d="M5 15l14 0" /><path d="M11 4l-4 16" /><path d="M17 4l-4 16" /></svg>'
