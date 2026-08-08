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

  local captured = nil
  local function capture()
    local cursor = vim.api.nvim_win_get_cursor(0)
    local register_type = vim.fn.getregtype('"')
    local register_text = vim.fn.getreg('"')
    if register_type == "V" and register_text:sub(-1) == "\n" then
      register_text = register_text:sub(1, -2)
    end
    captured = {
      text = table.concat(vim.api.nvim_buf_get_lines(0, 0, -1, false), "\n"),
      cursor = { row = cursor[1], byteColumn = cursor[2] },
      mode = mode_name(vim.api.nvim_get_mode().mode),
      register = {
        text = register_text,
        type = register_type == "V" and "linewise" or "characterwise",
      },
    }
  end
  vim.keymap.set({ "n", "i", "v", "x" }, "<F24>", capture, { nowait = true })
  local keys = vim.api.nvim_replace_termcodes(case.keys .. "<F24>", true, false, true)
  vim.api.nvim_feedkeys(keys, "xt", false)
  if captured == nil then
    error("oracle capture key was not processed for " .. case.name)
  end
  table.insert(results, captured)
end

io.write("OPENCODE_VIM_ORACLE=" .. vim.json.encode(results) .. "\n")
vim.cmd("qa!")
