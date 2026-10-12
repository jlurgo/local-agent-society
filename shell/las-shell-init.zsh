# Local Agent Society — shell integration (zsh). Sourced from ~/.zshrc by
# `las shell-init --install`; safe to source more than once.
#
# Terminal tint: on every cd, find the nearest .las-agent.json upward (the
# same rule LAS uses), read that agent's color from the widget prefs, and set
# the terminal background to it, mixed LAS_BG_MIX% over LAS_BG_BASE so text
# stays readable. Outside any agent folder the terminal's own background is
# restored. The terminal then works as the same signpost as the widget.
#
#   LAS_TINT=0          turn it off
#   LAS_TINT_FORCE=1    try it in a terminal not on the list below
#   LAS_BG_MIX=15       percent of the agent color (0-100)
#   LAS_BG_BASE=101010  dark base it is mixed over
#
# Mechanism: OSC 11 sets the background, OSC 111 resets it. Verified in
# Ghostty; iTerm2, WezTerm and kitty implement the same sequences. Inside
# tmux the sequence is wrapped for passthrough (needs `set -g
# allow-passthrough on`). A terminal that ignores OSC 11 just stays as is.

LAS_BG_MIX=${LAS_BG_MIX:-15}
LAS_BG_BASE=${LAS_BG_BASE:-101010}
_las_bg_root="-"

_las_tint_supported() {
  [[ $LAS_TINT == 0 ]] && return 1
  [[ -n $LAS_TINT_FORCE || -n $TMUX ]] && return 0
  case $TERM_PROGRAM in ghostty|iTerm.app|WezTerm) return 0 ;; esac
  [[ $TERM == xterm-kitty ]]
}

_las_osc() {  # $1 = OSC body, e.g. "11;#1a2b3c" or "111"
  if [[ -n $TMUX ]]; then
    printf '\ePtmux;\e\e]%s\a\e\\' "$1"
  else
    printf '\e]%s\a' "$1"
  fi
}

_las_widget_prefs() {
  if [[ $OSTYPE == darwin* ]]; then
    print -r -- "$HOME/Library/Application Support/widget-electron/widget-electron-prefs.json"
  else
    print -r -- "${XDG_CONFIG_HOME:-$HOME/.config}/widget-electron/widget-electron-prefs.json"
  fi
}

_las_bg_update() {
  _las_tint_supported || return
  (( $+commands[jq] )) || return
  local d=$PWD
  while [[ $d != / && ! -f $d/.las-agent.json ]]; do d=${d:h}; done
  [[ -f $d/.las-agent.json ]] || d=""
  [[ $d == $_las_bg_root ]] && return
  _las_bg_root=$d
  local name c out="" i a b
  [[ -n $d ]] && name=$(jq -r '.name // empty' "$d/.las-agent.json" 2>/dev/null)
  [[ -n $name ]] && c=$(jq -r --arg n "$name" '.agents[$n].color // empty' "$(_las_widget_prefs)" 2>/dev/null)
  c=${c#\#}
  if [[ ! $c =~ '^[0-9a-fA-F]{6}$' ]]; then _las_osc 111; return; fi
  for i in 0 2 4; do
    a=$((16#${c:$i:2})); b=$((16#${LAS_BG_BASE:$i:2}))
    out+=$(printf '%02x' $(( b + (a - b) * LAS_BG_MIX / 100 )))
  done
  _las_osc "11;#$out"
}

autoload -Uz add-zsh-hook
add-zsh-hook -d chpwd _las_bg_update 2>/dev/null
add-zsh-hook chpwd _las_bg_update
_las_bg_update
