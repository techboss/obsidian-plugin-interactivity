# This file is a part of Obsidian's Interactivity plugin

try:
	import matplotlib
	matplotlib.use('Agg')
	import matplotlib.pyplot as plt
	import io
	import base64
	_HAS_MATPLOTLIB = True
except ImportError:
	_HAS_MATPLOTLIB = False


# embeds a plot
def plot(*args, **kwargs) -> None:
	if not _HAS_MATPLOTLIB:
		print("Error: matplotlib not installed. Run: pip install matplotlib")
		return
	plt.set_loglevel('WARNING')
	plt.figure(figsize=(6, 4))
	plt.plot(*args, **kwargs)
	plt.grid()
	png_buffer = io.BytesIO()
	plt.savefig(png_buffer, format='png')
	plt.close('all')
	png_data = base64.b64encode(png_buffer.getvalue()).decode('utf-8')
	print(f'![Plot](data:image/png;base64,{png_data})\n')
