# This file is a part of Obsidian's Interactivity plugin

_HAS_TABLES = False
pd = None
tabulate = None

try:
	import pandas as _pd
	from tabulate import tabulate as _tabulate
	pd = _pd
	tabulate = _tabulate
	_HAS_TABLES = True
except ImportError:
	pass


# prints an Excel table
def excel_table(path: str, *args, **kwargs) -> None:
	if not _HAS_TABLES:
		print("Error: pandas/tabulate not installed. Run: pip install pandas openpyxl tabulate")
		return
	try:
		df = pd.read_excel(path, *args, **kwargs)
		markdown_table = tabulate(df, headers='keys', tablefmt='pipe')
		print(f'\n{markdown_table}\n')
	except:
		print('Unable to load the table\n')

# prints a CSV table
def csv_table(path: str, *args, **kwargs) -> None:
	if not _HAS_TABLES:
		print("Error: pandas/tabulate not installed. Run: pip install pandas tabulate")
		return
	try:
		df = pd.read_csv(path, *args, **kwargs)
		markdown_table = tabulate(df, headers='keys', tablefmt='pipe')
		print(f'\n{markdown_table}\n')
	except:
		print('Unable to load the table\n')
