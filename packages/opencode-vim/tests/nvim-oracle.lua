local request = vim.json.decode(io.read("*a"))
local results = {}

local function split_lines(text)
  if text == "" then
    return { "" }
  end
  return vim.split(text, "\n", { plain = true })
end

local function mode_name(mode)
  if mode:sub(1, 1) == "i" then
    return "insert"
  end
  if mode:sub(1, 1) == "v" or mode == "V" then
    return "visual"
  end
  return "normal"
end

for _, case in ipairs(request.cases) do
  vim.cmd("enew!")
  vim.api.nvim_buf_set_lines(0, 0, -1, false, split_lines(case.text))
  vim.api.nvim_win_set_cursor(0, { case.cursor.row, case.cursor.byteColumn })
  vim.fn.setreg('"', case.register.text, case.register.type == "linewise" and "V" or "v")

  local function capture()
    local mode = vim.api.nvim_get_mode().mode
    if mode:sub(1, 2) == "no" then
      error("case remained operator-pending: " .. case.name)
    end
    local cursor = vim.api.nvim_win_get_cursor(0)
    local register_type = vim.fn.getregtype('"')
    local register_text = vim.fn.getreg('"')
    if register_type == "V" and register_text:sub(-1) == "\n" then
      register_text = register_text:sub(1, -2)
    end
    return {
      text = table.concat(vim.api.nvim_buf_get_lines(0, 0, -1, false), "\n"),
      cursor = { row = cursor[1], byteColumn = cursor[2] },
      mode = mode_name(vim.api.nvim_get_mode().mode),
      register = {
        text = register_text,
        type = register_type == "V" and "linewise" or "characterwise",
      },
      pending = false,
    }
  end
  local captured = nil
  local capture_key = vim.api.nvim_replace_termcodes("<F24>", true, false, true)
  local pending_error = nil
  local capture_key_seen = false
  local on_key_namespace = vim.api.nvim_create_namespace("opencode-vim-oracle-" .. case.name)
  vim.on_key(function(key)
    if key == capture_key then
      capture_key_seen = true
      if vim.fn.mode(1):sub(1, 2) == "no" then
        pending_error = "case remained operator-pending: " .. case.name
      end
    end
  end, on_key_namespace)
  vim.keymap.set({ "n", "i", "v", "x" }, "<F24>", function()
    captured = capture()
  end, { nowait = true })
  local keys = vim.api.nvim_replace_termcodes(case.keys .. "<F24>", true, false, true)
  vim.api.nvim_feedkeys(keys, "xt", false)
  if captured == nil and not capture_key_seen then
    vim.api.nvim_feedkeys(capture_key, "xt", false)
  end
  vim.on_key(nil, on_key_namespace)
  if pending_error ~= nil then error(pending_error) end
  if captured == nil then error("case remained grammar-pending: " .. case.name) end
  table.insert(results, captured)
end

io.write("OPENCODE_VIM_ORACLE=" .. vim.json.encode(results) .. "\n")
vim.cmd("qa!")
