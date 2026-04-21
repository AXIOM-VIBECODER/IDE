# How to Open Folders in AXIOM

## ✅ Multiple Ways to Open Folders

### Method 1: File Menu (Recommended)
1. Click **File** in the top menu bar
2. Click **Open Folder...**
3. Enter the full path to your folder, for example:
   - `/home/esther-zawadi/Downloads/axiom_v6_zed_complete`
   - `/home/esther-zawadi/projects/myapp`
   - `~/Documents/code`
4. Press Enter
5. The folder structure will load in the left sidebar

### Method 2: Sidebar Button
1. Look at the left sidebar (File Explorer panel)
2. Click the **⊞** button (Open Folder button)
3. Enter the folder path
4. Press Enter

### Method 3: Keyboard Shortcut
1. Press **Ctrl+K** then **Ctrl+O**
2. Enter the folder path
3. Press Enter

### Method 4: Command Palette
1. Press **Ctrl+Shift+P** to open Command Palette
2. Type "Open folder"
3. Select the command
4. Enter the folder path

## 📂 Example Folder Paths

### Linux Paths
```
/home/esther-zawadi/Downloads/axiom_v6_zed_complete
/home/esther-zawadi/projects
~/Documents/myproject
~/code/webapp
/tmp/test
```

### What Happens After Opening
1. ✅ Folder structure appears in left sidebar
2. ✅ You can click any file to open it
3. ✅ File tree shows all files and folders
4. ✅ Project name appears in title bar
5. ✅ You can create new files/folders
6. ✅ Git integration activates (if it's a git repo)

## 🔧 Troubleshooting

### "Cannot open" error
- Make sure the path exists
- Check you have read permissions
- Try using absolute path (starting with `/`)
- Don't use quotes around the path

### Folder doesn't load
1. Check the browser console (F12) for errors
2. Verify the server is running
3. Try a different folder
4. Refresh the page and try again

## 💡 Tips

1. **Use Tab Completion**: Type partial path and the system will help
2. **Recent Folders**: Your recently opened folders are remembered
3. **Nested Navigation**: Click folders in the tree to expand them
4. **Quick Access**: Use `~` for home directory
5. **Refresh**: Click ↺ button to refresh the file tree

## 🎯 Quick Test

Try opening the AXIOM project itself:
```
/home/esther-zawadi/Downloads/axiom_v6_zed_complete/axiom_v6
```

This should show:
- `public/` folder with `index.html`, `admin.html`
- `src/` folder with `server.js`
- `start.sh` file
- Other project files

Once opened, you can:
- Click `index.html` to view/edit it
- Create new files with the + button
- Search files with Ctrl+P
- Use all IDE features
