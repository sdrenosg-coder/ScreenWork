sudo systemctl daemon-reload
sudo systemctl enable --now zipy-web zipy-worker
sudo systemctl status zipy-web zipy-worker
